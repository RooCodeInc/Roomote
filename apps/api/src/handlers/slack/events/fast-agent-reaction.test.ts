import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  acquireLock: vi.fn(),
  answerQuestion: vi.fn(),
  createArtifact: vi.fn(),
  createActivity: vi.fn(() => ({ start: vi.fn(), settle: vi.fn() })),
  findConversation: vi.fn(),
  findSession: vi.fn(),
  getActiveTasks: vi.fn(),
  lookupUser: vi.fn(),
  persistAdmission: vi.fn(),
  postThreadMessage: vi.fn(),
  recordProviderMessage: vi.fn(),
  releaseLock: vi.fn(),
  wakeParentEventAt: vi.fn(),
  wakeParentEventNow: vi.fn(),
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  acquireFastAgentTurnLock: mocks.acquireLock,
  answerFastAgentQuestion: mocks.answerQuestion,
  buildFastAgentReactionExternalInputQuestion: vi.fn(
    (input: unknown) =>
      `<external_input>${JSON.stringify(input)}</external_input>`,
  ),
  fastAgentConversationRepository: { findById: mocks.findConversation },
  getActiveFastAgentTasks: mocks.getActiveTasks,
}));

vi.mock('@roomote/communication', () => ({
  buildFastSessionReplyFooterText: vi.fn(() => 'footer'),
  resolveFastSessionReplyFooterContext: vi.fn(async () => ({})),
}));

vi.mock('@roomote/sdk/server', () => ({
  buildFastAgentArtifactCreator: vi.fn(() => mocks.createArtifact),
  findFastAgentSessionForProviderMessage: mocks.findSession,
  persistFastAgentInlineHumanTurn: mocks.persistAdmission,
  recordFastAgentConversationMessageBestEffort: mocks.recordProviderMessage,
  resolveUserMcpServerConfigs: vi.fn(async () => ({})),
  wakeFastAgentParentEventAt: mocks.wakeParentEventAt,
  wakeFastAgentParentEventNow: mocks.wakeParentEventNow,
}));

vi.mock('@roomote/slack', () => ({
  buildSlackThreadReplyFooterBlock: vi.fn(() => ({ type: 'context' })),
  createFastAgentSlackLiveTaskLauncher: vi.fn(() => vi.fn()),
  createFastAgentSlackSessionActivity: mocks.createActivity,
  getSlackThreadReplyFooterMessageTs: vi.fn(async () => null),
  withSlackThreadReplyFooterLock: vi.fn(
    async ({ fn }: { fn: () => Promise<unknown> }) => fn(),
  ),
}));

vi.mock('../helpers/thread-posting.js', () => ({
  postSlackThreadMarkdownMessage: mocks.postThreadMessage,
}));

vi.mock('../helpers/user-mapping.js', () => ({
  lookupSlackUserMapping: mocks.lookupUser,
}));

import { maybeRouteFastAgentReaction } from './fast-agent-reaction.js';

describe('Fast Slack reaction input', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.acquireLock.mockResolvedValue(mocks.releaseLock);
    mocks.releaseLock.mockResolvedValue(undefined);
    mocks.getActiveTasks.mockResolvedValue([]);
    mocks.lookupUser.mockResolvedValue({
      activeMapping: { userId: 'user-1' },
      hasInactiveMapping: false,
    });
    mocks.findSession.mockResolvedValue({
      id: 'session-1',
      userId: 'user-1',
      title: 'Investigate Slack agent status',
      conversation: {
        surface: 'slack',
        workspaceId: 'T1',
        conversationId: '100.000',
        replyTarget: { channelId: 'C1', threadId: '100.000' },
      },
    });
    mocks.answerQuestion.mockResolvedValue('');
    mocks.persistAdmission.mockResolvedValue(null);
  });

  it('admits a reaction turn durably so an interruption resumes it with the same reaction', async () => {
    // The row was still pending from an earlier attempt (a redelivered
    // event), so this run is a resumption.
    mocks.persistAdmission.mockResolvedValueOnce({
      id: 'row-1',
      eventKey: 'key-1',
      resumed: true,
    });
    const slack = {
      getMessage: vi.fn(async () => ({
        text: 'React to this message with your favorite emoji.',
        thread_ts: '100.000',
      })),
      normalizeIncomingText: vi.fn(async () => '@alice'),
      updateMessage: vi.fn(),
    };

    await expect(
      maybeRouteFastAgentReaction({
        context: {
          teamId: 'T1',
          slackInstallation: { botUserId: 'UROOMOTE' },
          slack,
        } as never,
        event: {
          type: 'reaction_added',
          user: 'UALICE',
          reaction: 'sparkling_heart',
          item: { type: 'message', channel: 'C1', ts: '101.000' },
          event_ts: '102.000',
        },
      }),
    ).resolves.toBe(true);
    await vi.waitFor(() => expect(mocks.answerQuestion).toHaveBeenCalledOnce());

    expect(mocks.persistAdmission).toHaveBeenCalledWith({
      parent: expect.objectContaining({ sessionId: 'session-1' }),
      event: expect.objectContaining({
        type: 'human_follow_up',
        eventId: 'slack-reaction:102.000',
        currentMessageId: 'slack-reaction:102.000',
        userId: 'user-1',
        senderExternalId: 'UALICE',
        senderDisplayName: '@alice',
        input: {
          type: 'reaction',
          externalInput: expect.objectContaining({
            type: 'reaction_added',
            reactions: [{ name: 'sparkling_heart' }],
          }),
        },
      }),
    });
    expect((mocks.releaseLock as { durableRowId?: string }).durableRowId).toBe(
      'row-1',
    );
    expect(mocks.answerQuestion).toHaveBeenCalledWith(
      expect.objectContaining({
        durableAdmission: { eventId: 'row-1' },
        resumedAfterInterruption: true,
        adapter: expect.objectContaining({
          createArtifact: mocks.createArtifact,
          requestDurableResume: expect.any(Function),
          requestDurableRetry: expect.any(Function),
        }),
      }),
    );
  });

  it('includes the Fast-authored message when a reaction can directly answer it', async () => {
    const slack = {
      getMessage: vi.fn(async () => ({
        text: 'React to this message with your favorite emoji.',
        thread_ts: '100.000',
      })),
      normalizeIncomingText: vi.fn(async () => '@alice'),
      updateMessage: vi.fn(),
    };

    await expect(
      maybeRouteFastAgentReaction({
        context: {
          teamId: 'T1',
          slackInstallation: { botUserId: 'UROOMOTE' },
          slack,
        } as never,
        event: {
          type: 'reaction_added',
          user: 'UALICE',
          reaction: 'sparkling_heart',
          item: { type: 'message', channel: 'C1', ts: '101.000' },
          event_ts: '102.000',
        },
      }),
    ).resolves.toBe(true);

    await vi.waitFor(() => expect(mocks.answerQuestion).toHaveBeenCalledOnce());
    expect(mocks.createActivity).toHaveBeenCalledWith({
      slack: expect.anything(),
      workspaceId: 'T1',
      channel: 'C1',
      threadTs: '100.000',
      title: 'Investigate Slack agent status',
      resolveTitle: expect.any(Function),
    });
    expect(mocks.findSession).toHaveBeenCalledWith({
      provider: 'slack',
      workspaceId: 'T1',
      channelId: 'C1',
      messageId: '101.000',
      userId: 'user-1',
    });
    expect(mocks.answerQuestion).toHaveBeenCalledWith(
      expect.objectContaining({
        currentMessageId: 'slack-reaction:102.000',
        senderExternalId: 'UALICE',
        senderDisplayName: '@alice',
        input: {
          type: 'reaction',
          externalInput: expect.objectContaining({
            type: 'reaction_added',
            provider: 'slack',
            reactions: [{ name: 'sparkling_heart' }],
          }),
        },
        question: expect.stringContaining(
          'React to this message with your favorite emoji.',
        ),
      }),
    );
    expect(mocks.postThreadMessage).not.toHaveBeenCalled();
  });

  it('does not route reactions from users who do not own the bound session', async () => {
    mocks.findSession.mockResolvedValue(null);

    await expect(
      maybeRouteFastAgentReaction({
        context: {
          teamId: 'T1',
          slackInstallation: { botUserId: 'UROOMOTE' },
          slack: {},
        } as never,
        event: {
          type: 'reaction_added',
          user: 'UBOB',
          reaction: 'eyes',
          item: { type: 'message', channel: 'C1', ts: '101.000' },
          event_ts: '102.000',
        },
      }),
    ).resolves.toBe(false);
    expect(mocks.answerQuestion).not.toHaveBeenCalled();
  });
});
