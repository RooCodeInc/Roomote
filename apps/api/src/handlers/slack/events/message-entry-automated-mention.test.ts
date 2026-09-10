import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  redis: {
    set: vi.fn(),
    del: vi.fn(),
  },
  startTask: vi.fn(),
  processAttachments: vi.fn(),
  automationLaunchIdentity: vi.fn(),
  processFastAgentMessage: vi.fn(),
  liveTaskLauncher: vi.fn(() => vi.fn()),
  lookupSlackUserMapping: vi.fn(),
}));

vi.mock('@roomote/env', () => ({
  Env: { TRPC_URL: null, R_APP_URL: 'http://localhost:3000' },
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  ROUTING_AUTO_CONFIRM_TIMEOUT_MS: 0,
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
  createFastAgentSlackLiveTaskLauncher: mocks.liveTaskLauncher,
}));

vi.mock('../helpers/attachments.js', () => ({
  processSlackAttachments: mocks.processAttachments,
}));

vi.mock('../helpers/launch-identity.js', () => ({
  getSlackAutomationLaunchIdentity: mocks.automationLaunchIdentity,
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

describe('automated Slack message mentions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.redis.set.mockResolvedValue('OK');
    mocks.redis.del.mockResolvedValue(1);
    mocks.processAttachments.mockResolvedValue({
      images: [],
      attachmentTexts: [],
      videoDescriptions: [],
    });
    mocks.automationLaunchIdentity.mockResolvedValue({
      launchUserId: 'USER_INSTALLER',
      slackUserId: 'U_INSTALLER',
    });
    mocks.startTask.mockResolvedValue({
      status: 'started',
      threadId: '1712345678.000200',
      runId: 'RUN_123',
      taskId: 'TASK_123',
    });
    mocks.lookupSlackUserMapping.mockResolvedValue({
      activeMapping: null,
      hasInactiveMapping: false,
    });
    mocks.processFastAgentMessage.mockImplementation(
      async ({ onAccepted }: { onAccepted?: (abort: () => void) => void }) => {
        onAccepted?.(() => {});
      },
    );
  });

  it('routes an external bot_message mentioning Roomote to Fast under the automation identity', async () => {
    const { handleMessageOrAppMentionEvent } =
      await import('./message-entry.js');

    await handleMessageOrAppMentionEvent({
      event: {
        type: 'message',
        subtype: 'bot_message',
        channel: 'C123',
        channel_type: 'channel',
        user: 'U_WORKFLOW',
        bot_id: 'B_WORKFLOW',
        app_id: 'A_WORKFLOW',
        text: '<@U_ROOMOTE> investigate this deployment',
        ts: '1712345678.000200',
      },
      context: {
        slackInstallation: {
          appId: 'A_ROOMOTE',
          botUserId: 'U_ROOMOTE',
          installedByUserId: 'USER_INSTALLER',
        } as never,
        slack: {} as never,
        teamId: 'T123',
      },
    });

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
          user: 'U_INSTALLER',
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
    expect(mocks.startTask).not.toHaveBeenCalled();
  }, 30000);

  it('releases the routing lock and launches nothing when the Fast turn is not accepted', async () => {
    mocks.processFastAgentMessage.mockImplementation(
      async ({ onRejected }: { onRejected?: () => void }) => {
        onRejected?.();
      },
    );

    const { handleMessageOrAppMentionEvent } =
      await import('./message-entry.js');

    await handleMessageOrAppMentionEvent({
      event: {
        type: 'message',
        subtype: 'bot_message',
        channel: 'C123',
        channel_type: 'channel',
        user: 'U_WORKFLOW',
        bot_id: 'B_WORKFLOW',
        app_id: 'A_WORKFLOW',
        text: '<@U_ROOMOTE> investigate this deployment',
        ts: '1712345678.000200',
      },
      context: {
        slackInstallation: {
          appId: 'A_ROOMOTE',
          botUserId: 'U_ROOMOTE',
          installedByUserId: 'USER_INSTALLER',
        } as never,
        slack: {} as never,
        teamId: 'T123',
      },
    });

    await vi.waitFor(() =>
      expect(mocks.redis.del).toHaveBeenCalledWith(
        expect.stringContaining('1712345678.000200'),
      ),
    );
    expect(mocks.startTask).not.toHaveBeenCalled();
  }, 30000);
});
