import {
  callBrainWriteTool,
  isBrainNotReady,
  isBrainRateLimited,
  redactBrainText,
} from '../brain-outbox-drain';
import type {
  BrainConnection,
  BrainSink,
  BrainTimelineSink,
  CollectorPage,
  EntityTimelineEvidence,
} from './contracts';

/**
 * Soft-delete one superseded page via gbrain's `delete_page` (write scope;
 * gbrain keeps a recovery window before the purge). Idempotent by design: a
 * retirement pass that partially applied before a restart retries the same
 * slugs, so a page that is already gone counts as retired. Backpressure keeps
 * its type so the engine ends the pass instead of burying it.
 */
export async function retireBrainPage(
  slug: string,
  connection: BrainConnection,
): Promise<void> {
  try {
    await callBrainWriteTool(connection, 'delete_page', { slug });
  } catch (error) {
    if (isBrainRateLimited(error) || isBrainNotReady(error)) {
      throw error;
    }

    const message = error instanceof Error ? error.message : String(error);

    if (/page_not_found|not[ _]found/i.test(message)) {
      return;
    }

    throw error;
  }
}

export async function appendBrainTimelineEvidence(
  evidence: EntityTimelineEvidence,
  connection: BrainConnection,
): Promise<void> {
  await callBrainWriteTool(connection, 'add_timeline_entry', evidence);
}

export async function writeCollectorPages(input: {
  pages: CollectorPage[];
  connection: BrainConnection;
  sink: BrainSink;
  timelineSink: BrainTimelineSink;
}): Promise<void> {
  const { pages, connection, sink, timelineSink } = input;

  for (const page of pages) {
    await sink({ ...page, content: redactBrainText(page.content) }, connection);
    for (const evidence of page.timelineEvidence ?? []) {
      await timelineSink(
        {
          ...evidence,
          summary: redactBrainText(evidence.summary),
          ...(evidence.detail
            ? { detail: redactBrainText(evidence.detail) }
            : {}),
        },
        connection,
      );
    }
  }
}
