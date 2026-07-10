import type {
  RunEventDetails,
  RunEventSource,
  RunEventType,
} from '@roomote/types';
import {
  db,
  recordTaskRunEvent as persistTaskRunEvent,
} from '@roomote/db/server';

export async function recordTaskRunEvent(input: {
  runId: number;
  source: RunEventSource;
  eventType: RunEventType;
  message?: string;
  details?: RunEventDetails;
}): Promise<void> {
  const { runId, ...rest } = input;
  await persistTaskRunEvent(db, { runId: runId, ...rest });
}
