import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  redis: {
    set: vi.fn(),
    del: vi.fn(),
    sismember: vi.fn(),
    get: vi.fn(),
  },
  processAttachments: vi.fn(),
  automationLaunchIdentity: vi.fn(),
  processFastAgentMessage: vi.fn(),
  liveTaskLauncher: vi.fn(() => vi.fn()),
  lookupSlackUserMapping: vi.fn(),
  getFastAgentSessionOwner: vi.fn(),
  fetchThreadMessages: vi.fn(),
  findTrackedBackgroundAutomationSlackThread: vi.fn(),
  recordInboundSlackConversationMessage: vi.fn(),
}));

vi.mock('@roomote/env', () => ({
  Env: { TRPC_URL: null, R_APP_URL: 'http://localhost:3000' },
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  ROUTING_AUTO_CONFIRM_TIMEOUT_MS: 0,
  getFastAgentSessionOwner: mocks.getFastAgentSessionOwner,
}));

vi.mock('@roomote/cloud-agents', () => ({
  stripLeadingRawSlackMention: vi.fn((text: string) => text),
  stripLeadingSlackProductMention: vi.fn((text: string) => text),
}));

vi.mock('@roomote/redis', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/redis')>()),
  getRedis: () => mocks.redis,
}));

vi.mock('@roomote/slack', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/slack')>()),
  acquireSlackFastRootBindingLock: vi.fn(async () => async () => {}),
  createFastAgentSlackLiveTaskLauncher: mocks.liveTaskLauncher,
  findActiveSlackTaskRun: vi.fn().mockResolvedValue(null),
}));

vi.mock('@roomote/db/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/db/server')>()),
  db: {},
  isSlackPeerConversationsExperimentEnabledForUser: vi
    .fn()
    .mockResolvedValue(false),
}));

vi.mock('../helpers/attachments.js', () => ({
  processSlackAttachments: mocks.processAttachments,
}));

vi.mock('../helpers/launch-identity.js', () => ({
  getSlackAutomationLaunchIdentity: mocks.automationLaunchIdentity,
}));

vi.mock('../helpers/conversation-log.js', () => ({
  findRoomoteOwnedSlackThread: vi.fn().mockResolvedValue(null),
  findTrackedBackgroundAutomationSlackThread:
    mocks.findTrackedBackgroundAutomationSlackThread,
  isRoomoteOwnedSlackThread: vi.fn().mockResolvedValue(false),
  recordInboundSlackConversationMessage:
    mocks.recordInboundSlackConversationMessage,
}));

vi.mock('./fast-agent.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./fast-agent.js')>()),
  processFastAgentMessage: mocks.processFastAgentMessage,
}));

vi.mock('../helpers/user-mapping.js', () => ({
  lookupSlackUserMapping: mocks.lookupSlackUserMapping,
}));

vi.mock('./thread-follow-up-dispatch.js', () => ({
  resolveSlackThreadFollowUpRoute: vi.fn().mockResolvedValue({ kind: 'fresh' }),
  dispatchSlackThreadFollowUp: vi.fn(
    async ({ onFresh }: { onFresh: () => Promise<boolean> }) => ({
      kind: 'fresh',
      value: await onFresh(),
    }),
  ),
}));

const ROOT_TS = '1712345678.000100';
const WORKFLOW = { bot_id: 'B_WORKFLOW', app_id: 'A_WORKFLOW' };

function rootMessage(overrides: Record<string, unknown> = {}) {
  return {
    ts: ROOT_TS,
    user: 'U_WORKFLOW',
    ...WORKFLOW,
    type: 'message',
    text: '<@U_ROOMOTE> *Suite — tests need updates*',
    ...overrides,
  };
}

function replyEvent(overrides: Record<string, unknown> = {}) {
  return {
    type: 'message',
    channel: 'C123',
    channel_type: 'channel',
    thread_ts: ROOT_TS,
    ts: '1712345679.000200',
    user: 'U_WORKFLOW',
    ...WORKFLOW,
    text: 'Suite — analysis',
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: 'The checkout assertion timed out.' },
      },
    ],
    ...overrides,
  } as never;
}

const context = {
  slackInstallation: {
    appId: 'A_ROOMOTE',
    botUserId: 'U_ROOMOTE',
    installedByUserId: 'USER_INSTALLER',
  } as never,
  slack: { fetchThreadMessages: mocks.fetchThreadMessages } as never,
  teamId: 'T123',
};

describe('automated Slack thread replies', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.redis.set.mockResolvedValue('OK');
    mocks.redis.del.mockResolvedValue(1);
    mocks.redis.sismember.mockResolvedValue(0);
    mocks.redis.get.mockResolvedValue(null);
    mocks.processAttachments.mockResolvedValue({
      images: [],
      attachmentTexts: [],
      videoDescriptions: [],
    });
    mocks.automationLaunchIdentity.mockResolvedValue({
      launchUserId: 'USER_INSTALLER',
      slackUserId: 'U_INSTALLER',
    });
    mocks.lookupSlackUserMapping.mockResolvedValue({
      activeMapping: null,
      hasInactiveMapping: false,
    });
    mocks.getFastAgentSessionOwner.mockResolvedValue({
      kind: 'user',
      userId: 'USER_INSTALLER',
    });
    mocks.fetchThreadMessages.mockResolvedValue([rootMessage()]);
    mocks.findTrackedBackgroundAutomationSlackThread.mockResolvedValue(null);
    mocks.processFastAgentMessage.mockImplementation(
      async ({ onAccepted }: { onAccepted?: (abort: () => void) => void }) => {
        onAccepted?.(() => {});
      },
    );
  });

  it("delivers the summoning app's own thread reply to the Session as a follow-up", async () => {
    const { handleMessageOrAppMentionEvent } =
      await import('./message-entry.js');

    await handleMessageOrAppMentionEvent({ event: replyEvent(), context });

    await vi.waitFor(() =>
      expect(mocks.processFastAgentMessage).toHaveBeenCalledTimes(1),
    );
    expect(mocks.processFastAgentMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'USER_INSTALLER',
        teamId: 'T123',
        directedAtRoomote: true,
        event: expect.objectContaining({
          channel: 'C123',
          thread_ts: ROOT_TS,
          user: 'U_INSTALLER',
          agentContext: expect.stringContaining(
            'The checkout assertion timed out.',
          ),
        }),
      }),
    );
    expect(mocks.liveTaskLauncher).toHaveBeenCalledWith(
      expect.objectContaining({
        initiator: {
          kind: 'automation',
          key: 'slack_channel_auto_start',
          actor: { externalId: 'U_WORKFLOW' },
        },
      }),
    );
  });

  it('ignores the reply when the thread has no Session', async () => {
    mocks.getFastAgentSessionOwner.mockResolvedValue(null);
    const { handleMessageOrAppMentionEvent } =
      await import('./message-entry.js');

    await handleMessageOrAppMentionEvent({ event: replyEvent(), context });

    expect(mocks.processFastAgentMessage).not.toHaveBeenCalled();
    expect(mocks.automationLaunchIdentity).not.toHaveBeenCalled();
  });

  it('ignores a reply from a different app than the root author', async () => {
    const { handleMessageOrAppMentionEvent } =
      await import('./message-entry.js');

    await handleMessageOrAppMentionEvent({
      event: replyEvent({ bot_id: 'B_OTHER', app_id: 'A_OTHER' }),
      context,
    });

    expect(mocks.processFastAgentMessage).not.toHaveBeenCalled();
  });

  it('ignores a same-app reply that arrives long after the root', async () => {
    const { handleMessageOrAppMentionEvent } =
      await import('./message-entry.js');

    await handleMessageOrAppMentionEvent({
      event: replyEvent({ ts: String(Number(ROOT_TS) + 16 * 60) }),
      context,
    });

    expect(mocks.processFastAgentMessage).not.toHaveBeenCalled();
    expect(mocks.automationLaunchIdentity).not.toHaveBeenCalled();
  });

  it('never delivers Roomote its own thread replies', async () => {
    const { handleMessageOrAppMentionEvent } =
      await import('./message-entry.js');

    await handleMessageOrAppMentionEvent({
      event: replyEvent({
        user: 'U_ROOMOTE',
        bot_id: 'U_ROOMOTE',
        app_id: 'A_ROOMOTE',
      }),
      context,
    });

    expect(mocks.processFastAgentMessage).not.toHaveBeenCalled();
    expect(mocks.getFastAgentSessionOwner).not.toHaveBeenCalled();
  });

  it('leaves a bot reply that addresses somebody else alone', async () => {
    const { handleMessageOrAppMentionEvent } =
      await import('./message-entry.js');

    await handleMessageOrAppMentionEvent({
      event: replyEvent({ text: '<@U_HUMAN> please take a look' }),
      context,
    });

    expect(mocks.processFastAgentMessage).not.toHaveBeenCalled();
  });
});
