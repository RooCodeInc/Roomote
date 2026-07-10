import type {
  RunEventDetails,
  RunEventSource,
  RunEventType,
} from '@roomote/types';
import {
  db,
  recordCloudJobEvent as persistCloudJobEvent,
} from '@roomote/db/server';

export async function recordCloudJobEvent(input: {
  cloudJobId: number;
  source: RunEventSource;
  eventType: RunEventType;
  message?: string;
  details?: RunEventDetails;
}): Promise<void> {
  const { cloudJobId, ...rest } = input;
  await persistCloudJobEvent(db, { runId: cloudJobId, ...rest });
}
