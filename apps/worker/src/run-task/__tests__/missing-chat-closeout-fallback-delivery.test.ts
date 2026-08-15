import { TaskEventName } from '@roomote/types';

const { claimDelivery, releaseDelivery, replyToChatThread } = vi.hoisted(
  () => ({
    claimDelivery: vi.fn(),
    releaseDelivery: vi.fn(),
    replyToChatThread: vi.fn(),
  }),
);

vi.mock('@roomote/sdk/client', () => ({
  sdk: {
    taskRuns: {
      claimMissingChatCloseoutFallbackDelivery: claimDelivery,
      recordInferenceUsage: vi.fn().mockResolvedValue({ recorded: true }),
      recordMessageEnvelope: vi.fn().mockResolvedValue(null),
      releaseMissingChatCloseoutFallbackDelivery: releaseDelivery,
      stampMilestone: vi.fn().mockResolvedValue(undefined),
    },
  },
}));

vi.mock('../../mcp/roomote-mcp-server/chat-api-client', () => ({
  replyToChatThread,
}));

import { deliverMissingChatCloseoutFallback } from '../missing-chat-closeout-fallback-delivery';
import { subscribeHarnessCallbacks } from '../subscribe-harness-callbacks';
import {
  cancelPendingMissingChatCloseoutFallback,
  recordMissingChatCloseoutFallback,
  settleMissingChatCloseoutFallback,
  waitForMissingChatCloseoutFallbackDelivery,
} from '../missing-chat-closeout-fallback-settlement';

const logger = {
  runId: 42,
  filePath: '/tmp/test.log',
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  log: vi.fn(),
};

const mcpTaskEnv = {
  ROOMOTE_CLOUD_TOKEN: 'token',
  ROOMOTE_PLATFORM_API_URL: 'https://platform.example.com/',
  ROOMOTE_COMMUNICATION_PROVIDER: 'discord',
  ROOMOTE_COMMUNICATION_CHANNEL_ID: 'channel-1',
};

describe('deliverMissingChatCloseoutFallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    claimDelivery.mockResolvedValue({ claimed: true });
    releaseDelivery.mockResolvedValue(undefined);
    replyToChatThread.mockResolvedValue({ messageTs: '123.456' });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('holds the fallback until the matching completion is settled', async () => {
    vi.useFakeTimers();
    const context = {};
    recordMissingChatCloseoutFallback(context, {
      runId: 42,
      completionId: 'completion-settled',
      text: 'Final answer after the goal settles.',
      mcpTaskEnv,
      logger,
    });

    expect(replyToChatThread).not.toHaveBeenCalled();

    await settleMissingChatCloseoutFallback(context, 'another-completion');
    expect(replyToChatThread).not.toHaveBeenCalled();

    await settleMissingChatCloseoutFallback(context, 'completion-settled');
    expect(replyToChatThread).not.toHaveBeenCalled();

    await vi.runAllTimersAsync();
    await waitForMissingChatCloseoutFallbackDelivery(context);
    expect(replyToChatThread).toHaveBeenCalledWith(expect.any(Object), {
      text: 'Final answer after the goal settles.',
    });
    vi.useRealTimers();
  });

  it('drops an exhausted closeout when a later completion supersedes it', async () => {
    const context = {};
    recordMissingChatCloseoutFallback(context, {
      runId: 42,
      completionId: 'continued-completion',
      text: 'Intermediate answer.',
      mcpTaskEnv,
      logger,
    });

    recordMissingChatCloseoutFallback(context, null);
    await settleMissingChatCloseoutFallback(context, 'continued-completion');
    await waitForMissingChatCloseoutFallbackDelivery(context);

    expect(replyToChatThread).not.toHaveBeenCalled();
  });

  it('delivers when settlement wins the event-ordering race', async () => {
    vi.useFakeTimers();
    const context = {};
    await settleMissingChatCloseoutFallback(context, 'completion-late-record');

    recordMissingChatCloseoutFallback(context, {
      runId: 42,
      completionId: 'completion-late-record',
      text: 'Final answer recorded after settlement.',
      mcpTaskEnv,
      logger,
    });
    await vi.runAllTimersAsync();
    await waitForMissingChatCloseoutFallbackDelivery(context);

    expect(replyToChatThread).toHaveBeenCalledWith(expect.any(Object), {
      text: 'Final answer recorded after settlement.',
    });
    vi.useRealTimers();
  });

  it('cancels a settled fallback when later runtime activity arrives', async () => {
    vi.useFakeTimers();
    const context = {};
    recordMissingChatCloseoutFallback(context, {
      runId: 42,
      completionId: 'completion-with-late-activity',
      text: null,
      mcpTaskEnv,
      logger,
    });

    await settleMissingChatCloseoutFallback(
      context,
      'completion-with-late-activity',
    );
    cancelPendingMissingChatCloseoutFallback(context);
    await vi.runAllTimersAsync();

    expect(replyToChatThread).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('cancels a settled fallback through the runtime subscription path', async () => {
    vi.useFakeTimers();
    const context = {};
    let outputListener: ((event: unknown) => void) | undefined;
    let taskListener: ((event: unknown) => void) | undefined;
    const unsubscribe = subscribeHarnessCallbacks({
      harness: {
        subscribe: (listener: (event: unknown) => void) => {
          taskListener = listener;
          return () => {};
        },
        subscribeRuntimeInferenceUsage: () => () => {},
        subscribeRuntimeOutput: (listener: (event: unknown) => void) => {
          outputListener = listener;
          return () => {};
        },
        subscribeRuntimePersistedEnvelope: () => () => {},
        subscribeRuntimeTurnCompleted: () => () => {},
      } as never,
      taskRun: { id: 42, taskId: 'task-with-late-tool-activity' } as never,
      callbacks: {},
      context,
      logger,
      mcpTaskEnv,
    });
    taskListener?.({
      eventName: TaskEventName.TaskCompleted,
      payload: [
        'task-with-late-tool-activity',
        {},
        {},
        {
          completionId: 'completion-with-late-tool-activity',
          isSubtask: false,
          missingChatCloseout: { reminderCount: 3 },
        },
      ],
    });
    await settleMissingChatCloseoutFallback(
      context,
      'completion-with-late-tool-activity',
    );

    outputListener?.({
      eventType: 'roomote_runtime.tool_call_update',
      role: 'assistant',
    });
    await vi.runAllTimersAsync();
    await unsubscribe();

    expect(replyToChatThread).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('flushes a settled fallback immediately during harness teardown', async () => {
    vi.useFakeTimers();
    const context = {};
    recordMissingChatCloseoutFallback(context, {
      runId: 42,
      completionId: 'completion-at-teardown',
      text: null,
      mcpTaskEnv,
      logger,
    });
    await settleMissingChatCloseoutFallback(context, 'completion-at-teardown');

    await waitForMissingChatCloseoutFallbackDelivery(context);

    expect(replyToChatThread).toHaveBeenCalledWith(expect.any(Object), {
      text: "I'm finished. Is there anything else you'd like me to do?",
    });
    vi.useRealTimers();
  });

  it('posts the last finalized assistant message through the shared chat path', async () => {
    await deliverMissingChatCloseoutFallback({
      runId: 42,
      completionId: 'completion-1',
      text: 'Final answer from the assistant.',
      mcpTaskEnv,
      logger,
    });

    expect(claimDelivery).toHaveBeenCalledWith({
      runId: 42,
      completionId: 'completion-1',
    });
    expect(replyToChatThread).toHaveBeenCalledWith(
      {
        token: 'token',
        platformApiUrl: 'https://platform.example.com',
      },
      { text: 'Final answer from the assistant.' },
    );
    expect(releaseDelivery).not.toHaveBeenCalled();
  });

  it('posts a friendly fallback when the finalized assistant message is empty', async () => {
    await deliverMissingChatCloseoutFallback({
      runId: 42,
      completionId: 'completion-1',
      text: '   ',
      mcpTaskEnv,
      logger,
    });

    expect(replyToChatThread).toHaveBeenCalledWith(expect.any(Object), {
      text: "I'm finished. Is there anything else you'd like me to do?",
    });
  });

  it('skips a fallback another delivery already claimed', async () => {
    claimDelivery.mockResolvedValue({ claimed: false });

    await deliverMissingChatCloseoutFallback({
      runId: 42,
      completionId: 'completion-1',
      text: 'Final answer.',
      mcpTaskEnv,
      logger,
    });

    expect(replyToChatThread).not.toHaveBeenCalled();
  });

  it('releases the claim without failing settlement when chat delivery fails', async () => {
    replyToChatThread.mockRejectedValue(new Error('chat unavailable'));

    await expect(
      deliverMissingChatCloseoutFallback({
        runId: 42,
        completionId: 'completion-1',
        text: 'Final answer.',
        mcpTaskEnv,
        logger,
      }),
    ).resolves.toBeUndefined();

    expect(releaseDelivery).toHaveBeenCalledWith({
      runId: 42,
      completionId: 'completion-1',
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('chat unavailable'),
    );
  });

  it('does nothing when the task did not originate from chat', async () => {
    await deliverMissingChatCloseoutFallback({
      runId: 42,
      completionId: 'completion-1',
      text: 'Final answer.',
      mcpTaskEnv: {
        ROOMOTE_CLOUD_TOKEN: 'token',
        ROOMOTE_PLATFORM_API_URL: 'https://platform.example.com',
      },
      logger,
    });

    expect(claimDelivery).not.toHaveBeenCalled();
    expect(replyToChatThread).not.toHaveBeenCalled();
  });
});
