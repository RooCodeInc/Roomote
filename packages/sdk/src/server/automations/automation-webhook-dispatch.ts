import {
  and,
  automationWebhookDeliveries,
  claimAutomationWebhookDelivery,
  cleanupAutomationWebhookDeliveries,
  db,
  eq,
  fastAgentParentEvents,
  flagStalledAutomationWebhookDeliveries,
  getCustomAutomationById,
  reconcileExhaustedAutomationWebhookDeliveries,
  retryAutomationWebhookDelivery,
  settleRunningAutomationWebhookDeliveryForSession,
  sql,
} from '@roomote/db/server';
import { acquireFastAgentTurnLock } from '@roomote/cloud-agents/server';
import {
  assertWebhookTriggerAuthorized,
  loadGranolaWebhookNote,
} from './automation-webhooks';
import { launchCustomAutomationRow } from './custom-automations';

/** PostgreSQL owns admission, retries and leases; the scheduler is only a wakeup. */
export async function processAutomationWebhookDeliveries(): Promise<void> {
  await reconcileExhaustedAutomationWebhookDeliveries();
  // The same lock used by Fast execution prevents a sweep from declaring
  // completion while an inline turn is still creating child work.
  const running = await db
    .select({ parent: fastAgentParentEvents.parent })
    .from(automationWebhookDeliveries)
    .innerJoin(
      fastAgentParentEvents,
      and(
        eq(
          fastAgentParentEvents.conversationId,
          automationWebhookDeliveries.sessionId,
        ),
        sql`${fastAgentParentEvents.event}->>'webhookDeliveryId' = ${automationWebhookDeliveries.id}::text`,
      ),
    )
    .where(eq(automationWebhookDeliveries.status, 'running'))
    .limit(100);
  for (const { parent } of running) {
    const release = await acquireFastAgentTurnLock({
      conversation: parent.conversation,
      maxWaitMs: 0,
    });
    if (!release) continue;
    try {
      await settleRunningAutomationWebhookDeliveryForSession(parent.sessionId);
    } finally {
      await release();
    }
  }
  await flagStalledAutomationWebhookDeliveries();
  await cleanupAutomationWebhookDeliveries();
  for (let processed = 0; processed < 20; processed++) {
    const delivery = await claimAutomationWebhookDelivery();
    if (!delivery) return;
    try {
      await assertWebhookTriggerAuthorized(delivery.triggerId);
      const automation = await getCustomAutomationById(delivery.automationId);
      if (!automation?.enabled || !automation.createdByUserId) {
        throw new Error(
          'Webhook automation owner or enabled configuration is unavailable.',
        );
      }
      const note = await loadGranolaWebhookNote(
        delivery.triggerId,
        delivery.noteId,
      );
      await assertWebhookTriggerAuthorized(delivery.triggerId);
      const result = await launchCustomAutomationRow(automation, {
        webhook: {
          deliveryId: delivery.id,
          triggerId: delivery.triggerId,
          leaseToken: delivery.leaseToken,
          untrustedNoteSummary: note.slice(0, 50_000),
        },
      });
      if (!result.queued) {
        await retryAutomationWebhookDelivery(
          delivery.id,
          delivery.leaseToken,
          result.errors.join('; ') ||
            result.skippedReason ||
            'Webhook dispatch did not enqueue execution.',
          result.errors.length === 0,
        );
      }
    } catch (error) {
      await retryAutomationWebhookDelivery(
        delivery.id,
        delivery.leaseToken,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}
