import { db, webhooks as webhooksTable, eq } from '@roomote/db/server';

import type { WebhookResponse } from '../../types';
import { redactWebhookPayload } from '../webhook-payload-redaction';

/**
 * Escape newline and carriage return characters to prevent log injection attacks.
 * This sanitizes untrusted input before including it in log messages.
 */
function escapeForLog(value: string): string {
  return value.replace(/[\r\n]/g, '\\n');
}

/**
 * Records a Linear webhook after executing the handler, setting status based on the response.
 * Uses INSERT ... ON CONFLICT DO NOTHING to atomically claim the deliveryId before
 * running the handler, ensuring true idempotency even under concurrent requests.
 * Handles both handler exceptions and database failures to ensure audit trail integrity.
 */
export async function recordLinearWebhook<T>(
  webhookId: string,
  event: string,
  payload: T,
  handler: () => Promise<WebhookResponse>,
): Promise<void> {
  // Atomically try to insert a placeholder record to claim this deliveryId.
  // If the insert succeeds (returns a row), we "won" the race and should process.
  // If it returns nothing (conflict on unique deliveryId), another request is
  // already processing this webhook - skip handler execution for idempotency.

  console.log(
    `[recordLinearWebhook] Received webhook ${escapeForLog(webhookId)} for event ${escapeForLog(event)}`,
  );

  let insertedRecord: { id: string } | undefined;
  let hadInsertError = false;

  try {
    const [result] = await db
      .insert(webhooksTable)
      .values({
        deliveryId: webhookId,
        provider: 'linear',
        event,
        // Only the stored copy is redacted; the handler still receives the
        // original payload.
        payload: redactWebhookPayload(payload),
        // No status timestamps set yet - will be updated after handler runs
      })
      .onConflictDoNothing()
      .returning({ id: webhooksTable.id });
    insertedRecord = result;

    if (result) {
      console.log(
        `[recordLinearWebhook] Successfully claimed webhook ${escapeForLog(webhookId)} - processing`,
      );
    } else {
      // Conflict: webhook is already being processed by another request
      console.log(
        `[recordLinearWebhook] Skipping duplicate webhook ${escapeForLog(webhookId)} (already processed or in progress)`,
      );
    }
  } catch (insertError) {
    // Database error (not a conflict) - proceed with handler execution to prioritize
    // availability over strict idempotency during transient database issues.
    hadInsertError = true;
    console.error(
      `[recordLinearWebhook] Failed to insert placeholder for webhook ${escapeForLog(webhookId)} - proceeding with handler anyway:`,
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
        `[recordLinearWebhook] Failed to update webhook ${escapeForLog(webhookId)} for event ${escapeForLog(event)}:`,
        updateError instanceof Error ? updateError.message : updateError,
      );
    }
  } else {
    // We processed the handler but couldn't record it due to DB error
    console.warn(
      `[recordLinearWebhook] Handler executed for webhook ${escapeForLog(webhookId)} but no database record exists (insert failed)`,
    );
  }
}
