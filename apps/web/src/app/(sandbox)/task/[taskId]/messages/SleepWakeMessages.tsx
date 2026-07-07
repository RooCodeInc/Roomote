'use client';

import { Moon } from '@/components/system';

import type { CloudJobDetail } from '@/lib/server';
import {
  Message,
  MessageContent,
  Tool,
  ToolHeader,
} from '@/components/ai-elements';

import { isCloudJobSnapshotting } from '../sidebar-actions/utils';

interface SleepWakeMessagesProps {
  cloudJob: CloudJobDetail;
}

export const SleepWakeMessages = ({ cloudJob }: SleepWakeMessagesProps) => {
  // ConnectionStatusBanner suppresses its disconnect states exactly while
  // this row is visible, so keep the two conditions in sync via the shared
  // predicate.
  const isSnapshotting = isCloudJobSnapshotting(cloudJob);

  const hasSnapshot = !!cloudJob.snapshotId;

  if (!isSnapshotting && !hasSnapshot) {
    return null;
  }

  return (
    <>
      {/* Fake "go_to_sleep" tool use */}
      <Message from="assistant" className="chat-tool-use-message">
        <MessageContent>
          <Tool defaultOpen={false}>
            <ToolHeader
              action={isSnapshotting ? 'Going to sleep' : 'Went to sleep'}
              icon={Moon}
              state={isSnapshotting ? 'input-available' : 'output-available'}
              collapsible={false}
            />
          </Tool>
        </MessageContent>
      </Message>
    </>
  );
};
