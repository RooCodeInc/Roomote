import { and, eq, inArray, sql } from 'drizzle-orm';

import {
  getTextFromContentBlocks,
  OUT_OF_BAND_RESURFACED_AT_METADATA_KEY,
  RESURFACE_OUT_OF_BAND_TASK_MESSAGE_SOURCES,
  ROOMOTE_RUNTIME_TASK_MESSAGE_PROTOCOL,
  type TaskMessageContentBlock,
} from '@roomote/types';

import { db } from '../db';
import { taskMessages } from '../schema';

export interface ClaimedOutOfBandTaskMessage {
  id: string;
  ts: number;
  text: string;
}

function extractOutOfBandMessageText(row: {
  contentBlocks: unknown;
  payload: unknown;
}): string | null {
  const fromBlocks = Array.isArray(row.contentBlocks)
    ? getTextFromContentBlocks(row.contentBlocks as TaskMessageContentBlock[])
    : null;

  if (fromBlocks?.trim()) {
    return fromBlocks;
  }

  const payload =
    row.payload &&
    typeof row.payload === 'object' &&
    !Array.isArray(row.payload)
      ? (row.payload as Record<string, unknown>)
      : null;

  // Whitespace-only text counts as no text: the row is consumed by the claim
  // but filtered from the result, matching the null-text handling, so callers
  // never build an empty context block from it.
  return typeof payload?.text === 'string' && payload.text.trim()
    ? payload.text
    : null;
}

/**
 * Atomically claims the task's out-of-band transcript messages (rows a
 * background job persisted to task history without ever entering the harness
 * session, e.g. PR review-feedback notifications) that have not been
 * re-surfaced into a delivered prompt yet. Kickoff messages are intentionally
 * excluded: they live in history only. Claimed rows are stamped with
 * `metadata.outOfBandResurfacedAt` so concurrent or later turns skip them;
 * use {@link releaseClaimedOutOfBandTaskMessages} if delivery then fails.
 */
export async function claimPendingOutOfBandTaskMessages(
  taskId: string,
): Promise<ClaimedOutOfBandTaskMessage[]> {
  const rows = await db
    .update(taskMessages)
    .set({
      metadata: sql`coalesce(${taskMessages.metadata}, '{}'::jsonb) || jsonb_build_object(${OUT_OF_BAND_RESURFACED_AT_METADATA_KEY}::text, to_jsonb(now()))`,
    })
    .where(
      and(
        eq(taskMessages.taskId, taskId),
        eq(taskMessages.protocol, ROOMOTE_RUNTIME_TASK_MESSAGE_PROTOCOL),
        inArray(sql`${taskMessages.metadata}->>'source'`, [
          ...RESURFACE_OUT_OF_BAND_TASK_MESSAGE_SOURCES,
        ]),
        sql`${taskMessages.metadata}->>${OUT_OF_BAND_RESURFACED_AT_METADATA_KEY} is null`,
      ),
    )
    .returning({
      id: taskMessages.id,
      ts: taskMessages.ts,
      contentBlocks: taskMessages.contentBlocks,
      payload: taskMessages.payload,
    });

  return rows
    .map((row) => {
      const text = extractOutOfBandMessageText(row);

      return text ? { id: row.id, ts: row.ts, text } : null;
    })
    .filter((row): row is ClaimedOutOfBandTaskMessage => row !== null)
    .sort((left, right) => left.ts - right.ts);
}

/**
 * Removes the re-surfaced marker from previously claimed out-of-band
 * messages so a retried turn can pick them up again after a failed delivery.
 */
export async function releaseClaimedOutOfBandTaskMessages(
  messageIds: string[],
): Promise<void> {
  if (messageIds.length === 0) {
    return;
  }

  await db
    .update(taskMessages)
    .set({
      metadata: sql`coalesce(${taskMessages.metadata}, '{}'::jsonb) - ${OUT_OF_BAND_RESURFACED_AT_METADATA_KEY}::text`,
    })
    .where(inArray(taskMessages.id, messageIds));
}
