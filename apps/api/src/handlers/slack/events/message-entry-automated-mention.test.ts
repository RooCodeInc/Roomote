import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  redis: {
    set: vi.fn(),
    del: vi.fn(),
  },
  startTask: vi.fn(),
  processAttachments: vi.fn(),
  automationLaunchIdentity: vi.fn(),
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
  createFastAgentSlackLiveTaskLauncher: vi.fn(() => vi.fn()),
  startAutoRoutedSlackTask: mocks.startTask,
}));

vi.mock('../helpers/attachments.js', () => ({
  processSlackAttachments: mocks.processAttachments,
}));

vi.mock('../helpers/launch-identity.js', () => ({
  getSlackAutomationLaunchIdentity: mocks.automationLaunchIdentity,
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
  });

  it('starts an automation task for an external bot_message mentioning Roomote', async () => {
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

    await vi.waitFor(() => expect(mocks.startTask).toHaveBeenCalledTimes(1));
    expect(mocks.startTask).toHaveBeenCalledWith(
      expect.objectContaining({
        initiator: {
          kind: 'automation',
          key: 'slack_channel_auto_start',
          actor: { externalId: 'U_WORKFLOW' },
        },
        channel: 'C123',
        prompt: '<@U_ROOMOTE> investigate this deployment',
        slackUserId: 'U_INSTALLER',
        threadTs: '1712345678.000200',
      }),
    );
  }, 30000);
});
