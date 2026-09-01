import { beforeEach, describe, expect, it, vi } from 'vitest';

const FAILURE_MESSAGE =
  "Sorry, Roomote couldn't start this task. Please try again in a moment.";

const mocks = vi.hoisted(() => ({
  redis: {
    set: vi.fn(),
    del: vi.fn(),
    sadd: vi.fn(),
  },
  evaluateGate: vi.fn(),
  startTask: vi.fn(),
  processAttachments: vi.fn(),
  recordInboundMessage: vi.fn(),
  postRoutingDebug: vi.fn(),
  automationLaunchIdentity: vi.fn(),
  processFastAgentMessage: vi.fn(),
  liveTaskLauncher: vi.fn(() => vi.fn()),
  logWarn: vi.fn(),
}));

vi.mock('../../../logging.js', () => ({
  apiLogger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: mocks.logWarn,
  },
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
  startAutoRoutedSlackTask: mocks.startTask,
}));

vi.mock('../../shared/channel-launch-gate.js', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../shared/channel-launch-gate.js')
  >()),
  evaluateChannelLaunchGate: mocks.evaluateGate,
}));

vi.mock('./fast-agent.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./fast-agent.js')>()),
  processFastAgentMessage: mocks.processFastAgentMessage,
}));

vi.mock('../helpers/attachments.js', () => ({
  processSlackAttachments: mocks.processAttachments,
}));

vi.mock('../helpers/launch-identity.js', () => ({
  getSlackAutomationLaunchIdentity: mocks.automationLaunchIdentity,
}));

vi.mock('../helpers/channel-auto-start-routing-debug.js', () => ({
  postChannelAutoStartRoutingDebug: mocks.postRoutingDebug,
}));

vi.mock('../helpers/conversation-log.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../helpers/conversation-log.js')>()),
  recordInboundSlackConversationMessage: mocks.recordInboundMessage,
}));

import { processSlackChannelAutoStartTask } from './message-entry.js';

const postMessage = vi.fn();
const slack = {
  addReaction: vi.fn(),
  getChannelName: vi.fn(),
  normalizeIncomingText: vi.fn(),
  postMessage,
};

const event = {
  type: 'message',
  channel: 'C123',
  channel_type: 'channel',
  user: 'U123',
  text: 'Please investigate this failure',
  ts: '111.000',
} as never;

async function runHandler(
  launchCriteria?: string,
  { isBotAuthored = false }: { isBotAuthored?: boolean } = {},
) {
  return processSlackChannelAutoStartTask({
    event,
    isBotAuthored,
    slackInstallation: { teamId: 'T123', botUserId: 'UBOT' } as never,
    slack: slack as never,
    userMapping: {
      id: 'mapping-1',
      slackUserId: 'U123',
      slackTeamId: 'T123',
      userId: 'user-1',
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    teamId: 'T123',
    ackEmoji: 'eyes',
    channelAutoStartLaunchMode: 'always_start',
    ...(launchCriteria ? { launchCriteria } : {}),
  });
}

async function flushBackgroundWork() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

describe('Slack channel auto-start failures', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.redis.set.mockResolvedValue('OK');
    mocks.redis.del.mockResolvedValue(1);
    mocks.redis.sadd.mockResolvedValue(1);
    mocks.processAttachments.mockResolvedValue({
      images: [],
      attachmentTexts: [],
      videoDescriptions: [],
    });
    mocks.recordInboundMessage.mockResolvedValue(undefined);
    mocks.postRoutingDebug.mockResolvedValue(undefined);
    mocks.automationLaunchIdentity.mockResolvedValue({
      launchUserId: 'installer-1',
      slackUserId: 'UBOT',
    });
    // Bot-authored coverage below exercises the direct-task fallback unless a
    // test opts into an accepted Fast turn explicitly.
    mocks.processFastAgentMessage.mockImplementation(
      async ({ onRejected }: { onRejected?: () => void }) => {
        onRejected?.();
      },
    );
    postMessage.mockResolvedValue({ ts: 'reply-1' });
    vi.mocked(slack.addReaction).mockResolvedValue(undefined);
    vi.mocked(slack.getChannelName).mockResolvedValue('forge');
    slack.normalizeIncomingText.mockImplementation(async (text: unknown) =>
      String(text),
    );
  });

  it('stays silent when launch criteria are not met', async () => {
    mocks.evaluateGate.mockResolvedValue({
      shouldLaunch: false,
      skipReason: 'criteria_not_met',
      debug: { llmDecision: 'skip', reason: 'not actionable' },
    });

    await expect(runHandler('Only actionable requests')).resolves.toBe(true);
    await flushBackgroundWork();

    expect(postMessage).not.toHaveBeenCalled();
    expect(mocks.startTask).not.toHaveBeenCalled();
  });

  it('stays silent when criteria skip diagnostics cannot be posted', async () => {
    mocks.evaluateGate.mockResolvedValue({
      shouldLaunch: false,
      skipReason: 'criteria_not_met',
      debug: { llmDecision: 'skip', reason: 'not actionable' },
    });
    mocks.postRoutingDebug.mockRejectedValue(new Error('debug post failed'));

    await expect(runHandler('Only actionable requests')).resolves.toBe(true);
    await flushBackgroundWork();

    expect(postMessage).not.toHaveBeenCalled();
    expect(mocks.startTask).not.toHaveBeenCalled();
    expect(mocks.logWarn).toHaveBeenCalledWith(
      expect.stringContaining('debug post failed'),
    );
  });

  it('replies when the launch classifier fails', async () => {
    mocks.evaluateGate.mockResolvedValue({
      shouldLaunch: false,
      skipReason: 'classifier_error',
      debug: { llmDecision: 'error', reason: 'provider unavailable' },
    });

    await expect(runHandler('Only actionable requests')).resolves.toBe(true);
    await flushBackgroundWork();

    expect(postMessage).toHaveBeenCalledWith({
      channel: 'C123',
      thread_ts: '111.000',
      text: FAILURE_MESSAGE,
      blocks: [{ type: 'markdown', text: FAILURE_MESSAGE }],
    });
    expect(mocks.startTask).not.toHaveBeenCalled();
  });

  it('replies when task startup throws', async () => {
    const errorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    mocks.startTask.mockRejectedValue(new Error('task queue unavailable'));

    await expect(runHandler()).resolves.toBe(true);
    await flushBackgroundWork();

    expect(postMessage).toHaveBeenCalledWith({
      channel: 'C123',
      thread_ts: '111.000',
      text: FAILURE_MESSAGE,
      blocks: [{ type: 'markdown', text: FAILURE_MESSAGE }],
    });
    errorSpy.mockRestore();
  });

  it('still replies when startup and routing diagnostics both fail', async () => {
    const errorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    mocks.evaluateGate.mockResolvedValue({
      shouldLaunch: true,
      debug: { llmDecision: 'launch', reason: 'actionable' },
    });
    mocks.startTask.mockRejectedValue(new Error('task queue unavailable'));
    mocks.postRoutingDebug.mockRejectedValue(new Error('debug post failed'));

    await expect(runHandler('Only actionable requests')).resolves.toBe(true);
    await flushBackgroundWork();

    expect(postMessage).toHaveBeenCalledWith({
      channel: 'C123',
      thread_ts: '111.000',
      text: FAILURE_MESSAGE,
      blocks: [{ type: 'markdown', text: FAILURE_MESSAGE }],
    });
    errorSpy.mockRestore();
  });

  it('stays silent when the classifier fails on a bot-authored message', async () => {
    mocks.evaluateGate.mockResolvedValue({
      shouldLaunch: false,
      skipReason: 'classifier_error',
      debug: { llmDecision: 'error', reason: 'provider unavailable' },
    });

    await expect(
      runHandler('Only actionable requests', { isBotAuthored: true }),
    ).resolves.toBe(true);
    await flushBackgroundWork();

    expect(postMessage).not.toHaveBeenCalled();
    expect(mocks.startTask).not.toHaveBeenCalled();
  });

  it('routes a bot-authored message to Fast under the automation identity when the turn is accepted', async () => {
    mocks.processFastAgentMessage.mockImplementation(
      async ({ onAccepted }: { onAccepted?: (abort: () => void) => void }) => {
        onAccepted?.(() => {});
      },
    );

    await expect(runHandler(undefined, { isBotAuthored: true })).resolves.toBe(
      true,
    );
    await flushBackgroundWork();

    expect(mocks.processFastAgentMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'installer-1',
        continuation: true,
        event: expect.objectContaining({ user: 'UBOT' }),
      }),
    );
    expect(mocks.liveTaskLauncher).toHaveBeenCalledWith(
      expect.objectContaining({
        initiator: {
          kind: 'automation',
          key: 'slack_channel_auto_start',
          actor: { externalId: 'U123' },
        },
      }),
    );
    expect(mocks.startTask).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('stays silent when task startup throws for a bot-authored message', async () => {
    const errorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    mocks.startTask.mockRejectedValue(new Error('task queue unavailable'));

    await expect(runHandler(undefined, { isBotAuthored: true })).resolves.toBe(
      true,
    );
    await flushBackgroundWork();

    expect(postMessage).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
