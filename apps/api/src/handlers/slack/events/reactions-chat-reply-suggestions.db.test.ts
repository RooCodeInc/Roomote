import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  db,
  eq,
  inArray,
  trackedMessages,
  workItems,
} from '@roomote/db/server';

const mocks = vi.hoisted(() => ({
  lookupSlackUserMapping: vi.fn(),
  routeFastReaction: vi.fn(),
  startFastAgentResponse: vi.fn(),
}));

vi.mock('@roomote/slack', () => ({
  resolveSlackReactionNames: vi.fn(async () => ({
    ackEmoji: 'eyes',
    completionEmoji: 'white_check_mark',
  })),
  createFastAgentSlackLiveTaskLauncher: vi.fn(),
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  fastAgentConversationRepository: {
    findById: vi.fn(),
    getOrCreate: vi.fn(),
  },
  launchPinnedFastSessionTask: vi.fn(),
}));

vi.mock('../helpers/suggestion-workspace.js', () => ({
  buildSeededSuggestionSlackText: vi.fn(
    (text: string, userId: string) => `${text}\n\nStarted by <@${userId}>.`,
  ),
  buildSuggestionBadgePrefix: vi.fn(() => ''),
  buildSuggestionSlackText: vi.fn(
    ({ title, brief }: { title: string; brief: string }) =>
      `**${title}**\n${brief}`,
  ),
  buildSuggestionTaskPromptText: vi.fn(() => 'implementation prompt'),
  findMatchingEnvironmentIdForRepositoryIds: vi.fn(),
  parseSetupSuggestionIdFromSlackMessageMetadata: vi.fn(() => null),
  repositoryIdsMatchSelection: vi.fn(),
  resolveSuggestionLaunchWorkspaceFromMetadata: vi.fn(),
}));

vi.mock('../helpers/user-mapping.js', () => ({
  lookupSlackUserMapping: mocks.lookupSlackUserMapping,
}));

vi.mock('../../call-roomote-via-emoji.js', () => ({
  getCallRoomoteViaEmojiConfiguration: vi.fn(async () => null),
}));

vi.mock('../../tasks/orphaned-work-item-run.js', () => ({
  cancelOrphanedWorkItemRunBestEffort: vi.fn(),
}));

vi.mock('./message-entry.js', () => ({
  handleMessageOrAppMentionEvent: vi.fn(),
  startFastAgentResponse: mocks.startFastAgentResponse,
}));

vi.mock('./fast-agent-reaction.js', () => ({
  maybeRouteFastAgentReaction: mocks.routeFastReaction,
}));

vi.mock('./task-suggestion-reaction-contention.js', () => ({
  runTaskSuggestionReactionContention: vi.fn(
    async ({ launch }: { launch: () => Promise<boolean> }) =>
      (await launch()) ? 'handled' : 'claim-cleared',
  ),
}));

import { handleReactionAddedEvent } from './reactions';

describe('Slack suggestion reaction execution-root persistence', () => {
  const workItemIds: string[] = [];
  const channelId = `slack-db-channel-${Date.now()}`;

  async function seedSuggestion(messageTs: string) {
    const [workItem] = await db
      .insert(workItems)
      .values({
        kind: 'suggestion',
        title: 'Fix the voice transcript race',
        brief: 'Do not retain acknowledgements for discarded requests.',
        sortOrder: workItemIds.length,
        status: 'open',
      })
      .returning({ id: workItems.id });

    if (!workItem) {
      throw new Error('Failed to seed suggestion work item');
    }
    workItemIds.push(workItem.id);

    const [trackedMessage] = await db
      .insert(trackedMessages)
      .values({
        surface: 'slack',
        kind: 'suggestion_card',
        dedupeKey: `${channelId}:${messageTs}`,
        channelId,
        messageTs,
        workItemId: workItem.id,
        metadata: {
          suggestionType: 'suggested_tasks',
          launchRouting: 'router',
        },
      })
      .returning({ id: trackedMessages.id });

    return { workItemId: workItem.id, trackedMessageId: trackedMessage!.id };
  }

  async function readState(params: {
    workItemId: string;
    trackedMessageId: string;
  }) {
    const [workItem] = await db
      .select({
        status: workItems.status,
        launchClaimedAt: workItems.launchClaimedAt,
        launchedTaskId: workItems.launchedTaskId,
      })
      .from(workItems)
      .where(eq(workItems.id, params.workItemId));
    const [trackedMessage] = await db
      .select({
        metadata: trackedMessages.metadata,
        threadTs: trackedMessages.threadTs,
      })
      .from(trackedMessages)
      .where(eq(trackedMessages.id, params.trackedMessageId));

    return { workItem, trackedMessage };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.lookupSlackUserMapping.mockResolvedValue({
      hasInactiveMapping: false,
      activeMapping: {
        id: 'mapping-1',
        userId: 'user-1',
        slackUserId: 'U1',
        slackTeamId: 'T1',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    mocks.routeFastReaction.mockResolvedValue(false);
  });

  afterEach(async () => {
    if (workItemIds.length > 0) {
      await db
        .delete(trackedMessages)
        .where(inArray(trackedMessages.workItemId, workItemIds));
      await db.delete(workItems).where(inArray(workItems.id, workItemIds));
      workItemIds.length = 0;
    }
  });

  it('persists the owned execution root before accepting the Fast launch', async () => {
    const messageTs = 'successful-card';
    const seeded = await seedSuggestion(messageTs);
    mocks.startFastAgentResponse.mockResolvedValue({ accepted: true });
    const slack = {
      addReaction: vi.fn(async () => true),
      postMessage: vi.fn(async () => 'successful-execution-root'),
      deleteMessage: vi.fn(),
      getMessageMetadata: vi.fn(),
    };

    await handleReactionAddedEvent({
      context: {
        teamId: 'T1',
        slackInstallation: { botUserId: 'UROOMOTE', teamId: 'T1' },
        slack,
      } as never,
      event: {
        type: 'reaction_added',
        user: 'U1',
        reaction: '+1',
        item: { type: 'message', channel: channelId, ts: messageTs },
        event_ts: 'successful-event',
      },
    });

    const state = await readState(seeded);
    expect(state.workItem).toMatchObject({
      status: 'launched',
      launchClaimedAt: null,
      launchedTaskId: null,
    });
    expect(state.trackedMessage).toMatchObject({
      threadTs: 'successful-execution-root',
      metadata: expect.objectContaining({
        executionChannelId: channelId,
        executionThreadTs: 'successful-execution-root',
        executionClaimedAt: expect.any(String),
      }),
    });
    expect(mocks.startFastAgentResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          ts: 'successful-execution-root',
          thread_ts: 'successful-execution-root',
        }),
      }),
    );
    expect(slack.deleteMessage).not.toHaveBeenCalled();
  });

  it('clears the execution root and restores an open claim when Fast rejects the launch', async () => {
    const messageTs = 'rejected-card';
    const seeded = await seedSuggestion(messageTs);
    mocks.startFastAgentResponse.mockResolvedValue({
      accepted: false,
      reason: 'Fast session is busy.',
    });
    const slack = {
      addReaction: vi.fn(async () => true),
      postMessage: vi
        .fn()
        .mockResolvedValueOnce('rejected-execution-root')
        .mockResolvedValueOnce('failure-message'),
      deleteMessage: vi.fn(async () => undefined),
      getMessageMetadata: vi.fn(),
    };

    await handleReactionAddedEvent({
      context: {
        teamId: 'T1',
        slackInstallation: { botUserId: 'UROOMOTE', teamId: 'T1' },
        slack,
      } as never,
      event: {
        type: 'reaction_added',
        user: 'U1',
        reaction: '+1',
        item: { type: 'message', channel: channelId, ts: messageTs },
        event_ts: 'rejected-event',
      },
    });

    const state = await readState(seeded);
    expect(state.workItem).toMatchObject({
      status: 'open',
      launchClaimedAt: null,
      launchedTaskId: null,
    });
    expect(state.trackedMessage).toEqual({
      threadTs: null,
      metadata: {
        suggestionType: 'suggested_tasks',
        launchRouting: 'router',
      },
    });
    expect(slack.deleteMessage).toHaveBeenCalledWith({
      channel: channelId,
      ts: 'rejected-execution-root',
    });
    expect(slack.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: expect.stringContaining('busy') }),
    );
  });
});
