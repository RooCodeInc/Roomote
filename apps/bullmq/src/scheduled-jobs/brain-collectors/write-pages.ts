import { callBrainWriteTool, redactBrainText } from '../brain-outbox-drain';
import type {
  BrainConnection,
  BrainSink,
  BrainTimelineSink,
  CollectorPage,
  EntityTimelineEvidence,
} from './contracts';

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
