import {
  db,
  eq,
  inArray,
  trackedMessages,
  workItems,
} from '@roomote/db/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  acquireRedisLock: vi.fn(),
  getConfiguration: vi.fn(),
  lookupSlackUserMapping: vi.fn(),
  routeFastReaction: vi.fn(),
  startFastAgentResponse: vi.fn(),
}));

vi.mock('@roomote/redis', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/redis')>()),
  acquireRedisLock: mocks.acquireRedisLock,
}));

vi.mock('../../call-roomote-via-emoji.js', () => ({
  getCallRoomoteViaEmojiConfiguration: mocks.getConfiguration,
}));

vi.mock('../helpers/user-mapping.js', () => ({
  lookupSlackUserMapping: mocks.lookupSlackUserMapping,
}));

vi.mock('./message-entry.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./message-entry.js')>()),
  startFastAgentResponse: mocks.startFastAgentResponse,
}));

vi.mock('./fast-agent-reaction.js', () => ({
  maybeRouteFastAgentReaction: mocks.routeFastReaction,
}));

import { handleReactionAddedEvent } from './reactions';

describe('Slack suggested-task reaction persistence', () => {
  const workItemIds: string[] = [];

  async function seedSuggestion() {
    const suffix = `${Date.now()}-${workItemIds.length}`;
    const [workItem] = await db
      .insert(workItems)
      .values({
        kind: 'suggestion',
        title: 'Fix retry fencing',
        brief: 'Keep acceptance recovery safe.',
        status: 'open',
        sortOrder: 0,
      })
      .returning({ id: workItems.id });
    workItemIds.push(workItem!.id);

    const [card] = await db
      .insert(trackedMessages)
      .values({
        surface: 'slack',
        kind: 'suggestion_card',
        dedupeKey: `slack-suggestion-db-test:${suffix}`,
        channelId: 'C1',
        messageTs: `card-${suffix}`,
        workItemId: workItem!.id,
        metadata: {
          suggestionType: 'suggested_tasks',
          launchRouting: 'router',
        },
      })
      .returning({ id: trackedMessages.id });

    return {
      cardId: card!.id,
      messageTs: `card-${suffix}`,
      workItemId: workItem!.id,
    };
  }

  async function react(messageTs: string, slack: Record<string, unknown>) {
    await handleReactionAddedEvent({
      context: {
        teamId: 'T1',
        slackInstallation: { botUserId: 'UROOMOTE', teamId: 'T1' },
        slack,
      } as never,
      event: {
        type: 'reaction_added',
        user: 'U1',
        reaction: 'thumbsup',
        item: { type: 'message', channel: 'C1', ts: messageTs },
        event_ts: 'event-ts',
      },
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    const releaseLock = Object.assign(
      vi.fn(async () => undefined),
      {
        renew: vi.fn(async () => true),
      },
    );
    mocks.acquireRedisLock.mockResolvedValue(releaseLock);
    mocks.getConfiguration.mockResolvedValue(null);
    mocks.lookupSlackUserMapping.mockResolvedValue({
      hasInactiveMapping: false,
      activeMapping: { userId: 'user-1' },
    });
    mocks.routeFastReaction.mockResolvedValue(false);
    mocks.startFastAgentResponse.mockResolvedValue({ accepted: true });
  });

  afterEach(async () => {
    if (workItemIds.length === 0) return;
    await db
      .delete(trackedMessages)
      .where(inArray(trackedMessages.workItemId, workItemIds));
    await db.delete(workItems).where(inArray(workItems.id, workItemIds));
    workItemIds.length = 0;
  });

  it('persists and finalizes one execution root for an accepted suggestion', async () => {
    const suggestion = await seedSuggestion();
    const slack = {
      addReaction: vi.fn(async () => true),
      deleteMessage: vi.fn(async () => undefined),
      getMessageMetadata: vi.fn(),
      postMessage: vi.fn(async () => 'execution-root-ts'),
    };

    await react(suggestion.messageTs, slack);
    await react(suggestion.messageTs, slack);

    const [item] = await db
      .select({
        status: workItems.status,
        claimedAt: workItems.launchClaimedAt,
      })
      .from(workItems)
      .where(eq(workItems.id, suggestion.workItemId));
    const [card] = await db
      .select({
        metadata: trackedMessages.metadata,
        threadTs: trackedMessages.threadTs,
      })
      .from(trackedMessages)
      .where(eq(trackedMessages.id, suggestion.cardId));

    expect(item).toEqual({ status: 'launched', claimedAt: null });
    expect(card).toMatchObject({
      threadTs: 'execution-root-ts',
      metadata: {
        executionChannelId: 'C1',
        executionThreadTs: 'execution-root-ts',
        executionClaimedAt: expect.any(String),
      },
    });
    expect(slack.postMessage).toHaveBeenCalledTimes(1);
    expect(mocks.startFastAgentResponse).toHaveBeenCalledTimes(1);
  });

  it('clears the owned execution root and releases the claim after rejection', async () => {
    const suggestion = await seedSuggestion();
    mocks.startFastAgentResponse.mockResolvedValue({
      accepted: false,
      reason: 'Fast session is busy.',
    });
    const slack = {
      addReaction: vi.fn(async () => true),
      deleteMessage: vi.fn(async () => undefined),
      getMessageMetadata: vi.fn(),
      postMessage: vi
        .fn()
        .mockResolvedValueOnce('execution-root-ts')
        .mockResolvedValueOnce('failure-message-ts'),
    };

    await react(suggestion.messageTs, slack);

    const [item] = await db
      .select({
        status: workItems.status,
        claimedAt: workItems.launchClaimedAt,
      })
      .from(workItems)
      .where(eq(workItems.id, suggestion.workItemId));
    const [card] = await db
      .select({
        metadata: trackedMessages.metadata,
        threadTs: trackedMessages.threadTs,
      })
      .from(trackedMessages)
      .where(eq(trackedMessages.id, suggestion.cardId));

    expect(item).toEqual({ status: 'open', claimedAt: null });
    expect(card).toEqual({
      metadata: {
        suggestionType: 'suggested_tasks',
        launchRouting: 'router',
      },
      threadTs: null,
    });
    expect(slack.deleteMessage).toHaveBeenCalledWith({
      channel: 'C1',
      ts: 'execution-root-ts',
    });
  });
});
