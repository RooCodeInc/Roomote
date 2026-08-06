import type { ReactionTaskEntry } from '@roomote/communication/reaction-task-entry';
import type { SlackTaskEntryMessage } from '@roomote/slack';

export function buildSlackReactionTaskEntryDispatch(entry: ReactionTaskEntry): {
  message: SlackTaskEntryMessage;
  ackTimestamp: string;
} {
  return {
    message: {
      type: 'reaction_task_entry',
      channel: entry.target.channelId,
      user: entry.requester.id,
      text: entry.prompt,
      ts: entry.target.messageId,
      thread_ts: entry.target.threadId ?? entry.target.messageId,
      sourceEventId: entry.sourceEventId,
    },
    ackTimestamp: entry.target.messageId,
  };
}
