import { describe, expect, it } from 'vitest';

import { buildSlackReactionTaskEntryDispatch } from './reaction-task-entry';

describe('Slack reaction task entry', () => {
  it('keeps the reaction event identity separate from its message target', () => {
    expect(
      buildSlackReactionTaskEntryDispatch({
        prompt: 'Act on this',
        requester: { id: 'slack-user-1', name: 'Ada Lovelace' },
        sourceEventId: '1710000001.000000',
        target: {
          channelId: 'channel-1',
          messageId: '1710000000.000100',
          threadId: '1710000000.000000',
        },
      }),
    ).toEqual({
      message: {
        type: 'reaction_task_entry',
        channel: 'channel-1',
        user: 'slack-user-1',
        text: 'Act on this',
        ts: '1710000000.000100',
        thread_ts: '1710000000.000000',
        sourceEventId: '1710000001.000000',
      },
      ackTimestamp: '1710000000.000100',
    });
  });
});
