import type {
  CloudJobEventDetails,
  CloudJobEventSource,
  CloudJobEventType,
} from '@roomote/types';
import {
  db,
  recordCloudJobEvent as persistCloudJobEvent,
} from '@roomote/db/server';

export async function recordCloudJobEvent(input: {
  cloudJobId: number;
  source: CloudJobEventSource;
  eventType: CloudJobEventType;
  message?: string;
  details?: CloudJobEventDetails;
}): Promise<void> {
  const { cloudJobId, ...rest } = input;
  await persistCloudJobEvent(db, { runId: cloudJobId, ...rest });
}
