import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  acquireLock: vi.fn(),
  answerQuestion: vi.fn(),
  createActivity: vi.fn(() => ({ start: vi.fn(), settle: vi.fn() })),
  findConversation: vi.fn(),
  findSession: vi.fn(),
  getActiveTasks: vi.fn(),
  lookupUser: vi.fn(),
  postThreadMessage: vi.fn(),
  recordProviderMessage: vi.fn(),
  releaseLock: vi.fn(),
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
  findFastAgentSessionForProviderMessage: mocks.findSession,
  recordFastAgentConversationMessageBestEffort: mocks.recordProviderMessage,
  resolveUserMcpServerConfigs: vi.fn(async () => ({})),
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
  });

  it('routes a reaction with its target and surrounding thread context', async () => {
    const slack = {
      getMessage: vi.fn(async () => ({
        text: 'I can do that.',
        thread_ts: '100.000',
      })),
      fetchThreadMessages: vi.fn(async () => [
        {
          user: 'UALICE',
          username: 'Alice',
          text: 'Please open a separate pull request for the Fast reaction fix.',
          ts: '100.500',
        },
        {
          username: 'Roomote',
          text: 'I can do that.',
          ts: '101.000',
          bot_id: 'BROOMOTE',
        },
      ]),
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
          reaction: 'arrow_forward',
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
    expect(slack.fetchThreadMessages).toHaveBeenCalledWith({
      channel: 'C1',
      threadTs: '100.000',
    });
    expect(mocks.answerQuestion).toHaveBeenCalledWith(
      expect.objectContaining({
        currentMessageId: 'slack-reaction:102.000',
        senderExternalId: 'UALICE',
        senderDisplayName: '@alice',
        turnSource: 'platform_event',
        platformEventKind: 'external_input',
        platformEventVisibility: 'optional',
        question: expect.stringContaining('I can do that.'),
        threadContext: [
          {
            user: 'UALICE',
            username: 'Alice',
            text: 'Please open a separate pull request for the Fast reaction fix.',
            ts: '100.500',
            bot_id: undefined,
          },
        ],
        platformEventTranscriptPayload: {
          externalInput: expect.objectContaining({
            type: 'reaction_added',
            provider: 'slack',
            reactions: [{ name: 'arrow_forward' }],
            reactor: {
              externalUserId: 'UALICE',
              displayName: '@alice',
            },
            message: expect.objectContaining({
              workspaceId: 'T1',
              channelId: 'C1',
              messageId: '101.000',
              threadId: '100.000',
              text: 'I can do that.',
            }),
            eventId: '102.000',
          }),
        },
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
