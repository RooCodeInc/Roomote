import { describe, expect, it } from 'vitest';

import {
  reactionTaskEntryToQueuedMessage,
  type ReactionTaskEntry,
} from '../reaction-task-entry';

const entry: ReactionTaskEntry = {
  prompt: 'Act on this',
  requester: { id: 'provider-user-1', name: 'Ada Lovelace' },
  sourceEventId: 'reaction-event-1',
  target: {
    channelId: 'channel-1',
    messageId: 'message-1',
    threadId: 'thread-1',
  },
};

describe('reaction task entry', () => {
  it.each(['discord', 'teams'] as const)(
    'preserves the shared task-entry contract for %s orchestration',
    (provider) => {
      expect(
        reactionTaskEntryToQueuedMessage(provider, entry, 'roomote-user-1'),
      ).toEqual({
        provider,
        text: 'Act on this',
        user: 'Ada Lovelace',
        userId: 'roomote-user-1',
        ts: 'reaction-event-1',
        channel: 'channel-1',
        threadTs: 'thread-1',
        ...(provider === 'discord'
          ? { turnPolicy: { reactionsAllowed: true } }
          : {}),
      });
    },
  );
});
