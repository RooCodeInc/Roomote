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
  await persistCloudJobEvent(db, input);
}
