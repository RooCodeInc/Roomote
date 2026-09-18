import {
  and,
  db,
  webhooks as webhooksTable,
  eq,
  isNull,
} from '@roomote/db/server';
import type { SourceControlProvider } from '@roomote/types';

import type { WebhookResponse } from '../../types';
import { logApiOperationalEvent } from '../../logging';
import { captureApiException } from '../../monitoring/sentry';
import { redactWebhookPayload } from '../webhook-payload-redaction';

const UNKNOWN_HANDLER_OUTCOME_ERROR =
  'Webhook handler outcome is unknown because a redelivery found its durable claim nonterminal; the handler was not replayed';

/**
 * Records a webhook after executing the handler, setting status based on the response.
 * Uses INSERT ... ON CONFLICT DO NOTHING to atomically claim the deliveryId before
 * running the handler, ensuring true idempotency even under concurrent requests.
 * Handles both handler exceptions and database failures to ensure audit trail integrity.
 */
export async function recordWebhook<T>(
  deliveryId: string,
  event: string,
  payload: T,
  handler: () => Promise<WebhookResponse>,
  { provider = 'github' }: { provider?: SourceControlProvider } = {},
): Promise<void> {
  // Atomically try to insert a placeholder record to claim this deliveryId.
  // If the insert succeeds (returns a row), we "won" the race and should process.
  // If it returns nothing (conflict on unique deliveryId), another request is
  // already processing this webhook - skip handler execution for idempotency.
  let insertedRecord: { id: string } | undefined;
  let hadInsertError = false;
  try {
    const [result] = await db
      .insert(webhooksTable)
      .values({
        deliveryId,
        provider,
        event,
        // Only the stored copy is redacted; the handler still receives the
        // original payload.
        payload: redactWebhookPayload(payload),
        // No status timestamps set yet - will be updated after handler runs
      })
      .onConflictDoNothing()
      .returning({ id: webhooksTable.id });
    insertedRecord = result;
    if (insertedRecord) {
      logApiOperationalEvent('info', 'source_control_webhook_persistence', {
        provider,
        deliveryId,
        eventType: event,
        outcome: 'persisted',
        reason: 'delivery_claimed',
      });
    }
  } catch (insertError) {
    // Database error (not a conflict) - proceed with handler execution to prioritize
    // availability over strict idempotency during transient database issues.
    hadInsertError = true;
    logApiOperationalEvent('error', 'source_control_webhook_persistence', {
      provider,
      deliveryId,
      eventType: event,
      outcome: 'failed',
      reason: 'claim_insert_failed_handler_continues',
      retryable: true,
    });
    captureApiException(
      new Error('Webhook persistence claim failed'),
      undefined,
      {
        component: 'source_control_webhook_persistence',
        errorType:
          insertError instanceof Error ? insertError.name : 'unknown_error',
        provider,
        deliveryId,
        eventType: event,
        phase: 'claim_insert',
      },
    );
    console.error(
      `[recordWebhook] Failed to insert placeholder for webhook ${deliveryId} - proceeding with handler anyway:`,
      insertError instanceof Error ? insertError.message : insertError,
    );
  }

  // Skip only if there was a conflict (not if there was a DB error)
  if (!hadInsertError && insertedRecord === undefined) {
    logApiOperationalEvent('info', 'source_control_webhook_admission', {
      provider,
      deliveryId,
      eventType: event,
      outcome: 'skipped',
      reason: 'duplicate_delivery',
    });
    // A nonterminal duplicate can be in progress or missing its final audit update.
    // Never replay it; the original handler can still overwrite this unknown result.
    try {
      const [recovered] = await db
        .update(webhooksTable)
        .set({
          failedAt: new Date(),
          error: UNKNOWN_HANDLER_OUTCOME_ERROR,
        })
        .where(
          and(
            eq(webhooksTable.provider, provider),
            eq(webhooksTable.deliveryId, deliveryId),
            isNull(webhooksTable.succeededAt),
            isNull(webhooksTable.failedAt),
          ),
        )
        .returning({ id: webhooksTable.id });

      if (recovered) {
        console.warn(
          `[recordWebhook] Finalized unclassified ${provider} webhook ${deliveryId} without replaying its handler`,
        );
      }
    } catch (recoveryError) {
      captureApiException(
        new Error('Webhook duplicate recovery failed'),
        undefined,
        {
          component: 'source_control_webhook_persistence',
          errorType:
            recoveryError instanceof Error
              ? recoveryError.name
              : 'unknown_error',
          provider,
          deliveryId,
          eventType: event,
          phase: 'duplicate_recovery',
        },
      );
      console.error(
        `[recordWebhook] Failed to finalize unclassified ${provider} webhook ${deliveryId}:`,
        recoveryError instanceof Error ? recoveryError.message : recoveryError,
      );
    }
    return;
  }

  let response: WebhookResponse;

  try {
    response = await handler();
  } catch (error) {
    captureApiException(new Error('Webhook handler failed'), undefined, {
      component: 'source_control_webhook_handler',
      errorType: error instanceof Error ? error.name : 'unknown_error',
      provider,
      deliveryId,
      eventType: event,
    });
    console.error(
      `[recordWebhook] Handler failed for ${provider} webhook ${deliveryId} (${event}):`,
      error instanceof Error ? error.message : error,
    );

    // Handler threw an exception - record the failure
    response = {
      status: 'error',
      message:
        error instanceof Error ? error.message : 'Unknown handler exception',
    };
  }

  logApiOperationalEvent(
    response.status === 'ok' ? 'info' : 'error',
    'source_control_webhook_handler_terminal',
    {
      provider,
      deliveryId,
      eventType: event,
      outcome: response.status === 'ok' ? 'processed' : 'failed',
      reason: response.status === 'ok' ? 'handled' : 'handler_error',
      retryable: response.status === 'error',
    },
  );

  // Update the placeholder record with the handler result (only if we successfully inserted one)
  if (insertedRecord) {
    try {
      await db
        .update(webhooksTable)
        .set({
          succeededAt: response.status === 'ok' ? new Date() : null,
          failedAt: response.status === 'error' ? new Date() : null,
          error:
            response.status === 'error'
              ? (response.message ?? 'Unknown error')
              : null,
        })
        .where(eq(webhooksTable.id, insertedRecord.id));
    } catch (updateError) {
      logApiOperationalEvent('error', 'source_control_webhook_persistence', {
        provider,
        deliveryId,
        eventType: event,
        outcome: 'failed',
        reason: 'terminal_update_failed',
        retryable: true,
      });
      captureApiException(
        new Error('Webhook terminal persistence failed'),
        undefined,
        {
          component: 'source_control_webhook_persistence',
          errorType:
            updateError instanceof Error ? updateError.name : 'unknown_error',
          provider,
          deliveryId,
          eventType: event,
          phase: 'terminal_update',
        },
      );
      // Log database update failure to prevent silent audit trail gaps
      console.error(
        `[recordWebhook] Failed to update webhook ${deliveryId} for event ${event}:`,
        updateError instanceof Error ? updateError.message : updateError,
      );
    }
  } else {
    console.warn(
      `[recordWebhook] Handler executed for webhook ${deliveryId} but no database record exists (insert failed)`,
    );
  }
}
