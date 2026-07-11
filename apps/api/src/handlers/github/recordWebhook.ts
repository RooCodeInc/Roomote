import { db, webhooks as webhooksTable, eq } from '@roomote/db/server';
import type { SourceControlProvider } from '@roomote/types';

import type { WebhookResponse } from '../../types';
import { redactWebhookPayload } from '../webhook-payload-redaction';

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
  } catch (insertError) {
    // Database error (not a conflict) - proceed with handler execution to prioritize
    // availability over strict idempotency during transient database issues.
    hadInsertError = true;
    console.error(
      `[recordWebhook] Failed to insert placeholder for webhook ${deliveryId} - proceeding with handler anyway:`,
      insertError instanceof Error ? insertError.message : insertError,
    );
  }

  // Skip only if there was a conflict (not if there was a DB error)
  if (!hadInsertError && insertedRecord === undefined) {
    return;
  }

  let response: WebhookResponse;

  try {
    response = await handler();
  } catch (error) {
    // Handler threw an exception - record the failure
    response = {
      status: 'error',
      message:
        error instanceof Error ? error.message : 'Unknown handler exception',
    };
  }

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
