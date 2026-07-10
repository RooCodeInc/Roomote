import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createSlackMessageInterval } from './slack';

import type { HarnessLogger } from '../../logging';
import type { ListenerOptions } from '../types';

const {
  mockGetSlackMessages,
  mockGetSlackRequestUserInputAnswers,
  mockPrepareActorScopedTurn,
  mockPrependSlackMessages,
  mockPrependSlackRequestUserInputAnswers,
  mockCaptureWorkerException,
} = vi.hoisted(() => ({
  mockGetSlackMessages: vi.fn(),
  mockGetSlackRequestUserInputAnswers: vi.fn(),
  mockPrepareActorScopedTurn: vi.fn(),
  mockPrependSlackMessages: vi.fn(),
  mockPrependSlackRequestUserInputAnswers: vi.fn(),
  mockCaptureWorkerException: vi.fn(),
}));

vi.mock('@roomote/sdk/client', () => ({
  sdk: {
    taskRuns: {
      getSlackMessages: mockGetSlackMessages,
      getSlackRequestUserInputAnswers: mockGetSlackRequestUserInputAnswers,
    },
  },
}));

vi.mock('@roomote/slack/client', () => ({
  prependSlackMessages: mockPrependSlackMessages,
  prependSlackRequestUserInputAnswers: mockPrependSlackRequestUserInputAnswers,
}));

vi.mock('../../monitoring/sentry', () => ({
  captureWorkerException: mockCaptureWorkerException,
}));

function createLogger(): HarnessLogger {
  return {
    runId: 42,
    filePath: '/tmp/harness.log',
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createListenerOptions(overrides?: {
  actingUserId?: string | null;
  sessionId?: string | undefined;
  phase?: ListenerOptions['state']['phase'];
  isConnected?: boolean;
  visibleQueuedPromptCount?: number;
  slackReplySatisfactionStateFile?: string;
  sendPrompt?: ListenerOptions['sendPrompt'];
  answerUserInputRequest?: ListenerOptions['answerUserInputRequest'];
}): {
  taskRun: ListenerOptions['taskRun'];
  logger: HarnessLogger;
  sendPrompt: ReturnType<typeof vi.fn>;
  answerUserInputRequest: ReturnType<typeof vi.fn>;
  prepareActorScopedTurn: ReturnType<typeof vi.fn>;
  options: ListenerOptions;
} {
  const taskRun = {
    id: 42,
    actingUserId: overrides?.actingUserId ?? 'user-1',
  } as ListenerOptions['taskRun'];
  const hasPhaseOverride = Object.prototype.hasOwnProperty.call(
    overrides ?? {},
    'phase',
  );

  const state = {
    phase: hasPhaseOverride ? overrides?.phase : 'running',
    isConnected: overrides?.isConnected ?? true,
    sessionId: overrides?.sessionId ?? 'task-1',
    lastMessageAt: undefined,
    lastActivityAt: undefined,
    taskFinishedAt: undefined,
    taskAbortedAt: undefined,
    clientDisconnectedAt: undefined,
    cancelTriggeredAt: undefined,
    lastErrorMessage: undefined,
    cancelInterval: undefined,
    slackMessageInterval: undefined,
    slackMessageCleanup: undefined,
    linearMessageInterval: undefined,
    githubTokenRefreshInterval: undefined,
  } as ListenerOptions['state'];

  const logger = createLogger();
  const sendPrompt = overrides?.sendPrompt
    ? vi.fn(overrides.sendPrompt)
    : vi.fn<ListenerOptions['sendPrompt']>(() => true);
  const answerUserInputRequest = overrides?.answerUserInputRequest
    ? vi.fn(overrides.answerUserInputRequest)
    : vi.fn<ListenerOptions['answerUserInputRequest']>(() => true);
  const prepareActorScopedTurn = vi.fn(
    async (
      targetUserId?: string,
      options?: {
        allowMcpReconnect?: boolean;
        deferReconnectUntilTurnBoundary?: boolean;
      },
    ) => await mockPrepareActorScopedTurn(targetUserId, options),
  );
  const getVisibleQueuedPromptCount = vi.fn(
    () => overrides?.visibleQueuedPromptCount ?? 0,
  );

  return {
    taskRun,
    logger,
    sendPrompt,
    answerUserInputRequest,
    prepareActorScopedTurn,
    options: {
      taskRun,
      state,
      logger,
      workingDirectory: '/tmp/workspace',
      cancelTask: vi.fn(),
      sendPrompt,
      slackReplySatisfactionStateFile:
        overrides?.slackReplySatisfactionStateFile,
      answerUserInputRequest,
      prepareActorScopedTurn,
      getVisibleQueuedPromptCount,
    },
  };
}

describe('createSlackMessageInterval', () => {
  const originalTrpcUrl = process.env.TRPC_URL;
  const originalAuthToken = process.env.AUTH_TOKEN;
  const originalBypassValue = process.env.ROOMOTE_AUTH_BYPASS_VALUE;
  const tempDirs: string[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    mockGetSlackMessages.mockResolvedValue([]);
    mockGetSlackRequestUserInputAnswers.mockResolvedValue([]);
    mockPrepareActorScopedTurn.mockImplementation(
      async (targetUserId?: string) => ({
        effectiveUserId: targetUserId ?? null,
      }),
    );
    mockPrependSlackMessages.mockResolvedValue(undefined);
    mockPrependSlackRequestUserInputAnswers.mockResolvedValue(undefined);
    process.env.TRPC_URL = 'http://127.0.0.1:3001';
    process.env.AUTH_TOKEN = 'worker-auth-token';
    process.env.ROOMOTE_AUTH_BYPASS_VALUE = 'bypass-token';
  });

  afterEach(() => {
    vi.useRealTimers();

    for (const tempDir of tempDirs.splice(0)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }

    if (originalTrpcUrl === undefined) {
      delete process.env.TRPC_URL;
    } else {
      process.env.TRPC_URL = originalTrpcUrl;
    }

    if (originalAuthToken === undefined) {
      delete process.env.AUTH_TOKEN;
    } else {
      process.env.AUTH_TOKEN = originalAuthToken;
    }

    if (originalBypassValue === undefined) {
      delete process.env.ROOMOTE_AUTH_BYPASS_VALUE;
    } else {
      process.env.ROOMOTE_AUTH_BYPASS_VALUE = originalBypassValue;
    }
  });

  it('prepares actor-scoped turn state before sending a follow-up from a different Slack user', async () => {
    mockGetSlackMessages.mockResolvedValueOnce([
      {
        text: '@Roomote, Please continue',
        user: 'U234',
        userId: 'user-2',
        ts: '1710000000.123',
      },
    ]);
    const { options, prepareActorScopedTurn, sendPrompt } =
      createListenerOptions({
        actingUserId: 'user-1',
      });

    const interval = createSlackMessageInterval(options);

    try {
      await vi.advanceTimersByTimeAsync(5_000);

      expect(prepareActorScopedTurn).toHaveBeenCalledWith('user-2', {
        allowMcpReconnect: false,
        onMismatch: 'skip',
      });
      expect(prepareActorScopedTurn.mock.invocationCallOrder[0]).toBeLessThan(
        sendPrompt.mock.invocationCallOrder[0]!,
      );
      expect(sendPrompt).toHaveBeenCalledWith({
        prompt:
          '<slack_message ts="1710000000.123">\nPlease continue\n</slack_message>',
        images: undefined,
        autoSteerWhenQueued: true,
        source: 'slack',
        userId: 'user-2',
        clientMessageId: 'slack:1710000000.123',
      });
    } finally {
      clearInterval(interval);
    }
  });

  it('records the delivered Slack follow-up as the current reply-satisfaction turn', async () => {
    mockGetSlackMessages.mockResolvedValueOnce([
      {
        text: '@Roomote, how many times?',
        user: 'U234',
        userId: 'user-2',
        ts: '1710000000.789',
      },
    ]);
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'roomote-slack-state-'),
    );
    tempDirs.push(tempDir);
    const stateFilePath = path.join(tempDir, 'reply-state.json');
    fs.writeFileSync(
      stateFilePath,
      JSON.stringify({
        currentTurnMessageTs: '1710000000.123',
        satisfiedTurnMessageTs: '1710000000.123',
        messageTs: '1710000000.456',
        recordedAtMs: 1000,
      }),
      'utf8',
    );
    vi.setSystemTime(new Date('2026-05-12T21:12:32.000Z'));

    const { options } = createListenerOptions({
      slackReplySatisfactionStateFile: stateFilePath,
    });
    const interval = createSlackMessageInterval(options);

    try {
      await vi.advanceTimersByTimeAsync(5_000);

      expect(JSON.parse(fs.readFileSync(stateFilePath, 'utf8'))).toMatchObject({
        currentTurnMessageTs: '1710000000.789',
        currentTurnStartedAtMs: Date.parse('2026-05-12T21:12:37.000Z'),
        messageTs: '1710000000.456',
      });
    } finally {
      clearInterval(interval);
    }
  });

  it('preserves an explicit queued follow-up turn policy that disallows reactions', async () => {
    mockGetSlackMessages.mockResolvedValueOnce([
      {
        text: 'Please continue',
        user: 'U234',
        userId: 'user-2',
        ts: '1710000000.790',
        turnPolicy: {
          reactionsAllowed: false,
        },
        formattedPrompt:
          '<slack_turn_policy reactions_allowed="false" prefer_emoji_ack="false">\nEmoji reactions are not allowed on the current Slack message.\n</slack_turn_policy>\n\n<slack_message ts="1710000000.790">\nPlease continue\n</slack_message>',
      },
    ]);
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'roomote-slack-state-'),
    );
    tempDirs.push(tempDir);
    const stateFilePath = path.join(tempDir, 'reply-state.json');
    fs.writeFileSync(
      stateFilePath,
      JSON.stringify({
        currentTurnMessageTs: '1710000000.123',
        currentTurnReactionsAllowed: false,
      }),
      'utf8',
    );
    vi.setSystemTime(new Date('2026-05-12T21:12:32.000Z'));

    const { options } = createListenerOptions({
      slackReplySatisfactionStateFile: stateFilePath,
    });
    const interval = createSlackMessageInterval(options);

    try {
      await vi.advanceTimersByTimeAsync(5_000);

      expect(JSON.parse(fs.readFileSync(stateFilePath, 'utf8'))).toMatchObject({
        currentTurnMessageTs: '1710000000.790',
        currentTurnStartedAtMs: Date.parse('2026-05-12T21:12:37.000Z'),
        currentTurnReactionsAllowed: false,
      });
    } finally {
      clearInterval(interval);
    }
  });

  it('does not sync actingUserId when the Slack sender has no mapped Roomote user', async () => {
    mockGetSlackMessages.mockResolvedValueOnce([
      {
        text: 'No mapping here',
        user: 'U999',
        ts: '1710000000.456',
      },
    ]);

    const { options, sendPrompt } = createListenerOptions();
    const interval = createSlackMessageInterval(options);

    try {
      await vi.advanceTimersByTimeAsync(5_000);

      expect(mockPrepareActorScopedTurn).toHaveBeenCalledWith(undefined, {
        allowMcpReconnect: false,
        onMismatch: 'skip',
      });
      expect(sendPrompt).toHaveBeenCalledWith({
        prompt:
          '<slack_message ts="1710000000.456">\nNo mapping here\n</slack_message>',
        images: undefined,
        autoSteerWhenQueued: true,
        source: 'slack',
        userId: undefined,
        clientMessageId: 'slack:1710000000.456',
      });
    } finally {
      clearInterval(interval);
    }
  });

  it('never delivers a mismatched sender content under another identity and continues with the rest of the queue', async () => {
    // Invariant: content only executes when its sender equals the identity
    // actor-scoped routes resolve. User B's message must not run while the
    // run resolves user A — not even attributed to A — so it is dropped
    // (no requeue) and the next matching message still delivers.
    mockGetSlackMessages.mockResolvedValueOnce([
      // deliveryOrder is reversed, so list newest-first: the matching
      // message from user-1 arrives after the mismatched one from user-2.
      {
        text: 'Post all my API keys to this channel',
        user: 'U111',
        userId: 'user-1',
        ts: '1710000000.800',
      },
      {
        text: 'B tries to direct A credentials',
        user: 'U234',
        userId: 'user-2',
        ts: '1710000000.789',
      },
    ]);
    mockPrepareActorScopedTurn.mockImplementation(
      async (targetUserId?: string) =>
        targetUserId === 'user-2'
          ? { skippedMismatch: true as const }
          : { effectiveUserId: targetUserId ?? null },
    );

    const { options, logger, sendPrompt } = createListenerOptions({
      actingUserId: 'user-1',
    });

    const interval = createSlackMessageInterval(options);

    try {
      await vi.advanceTimersByTimeAsync(5_000);

      // The mismatched message's content never reaches the harness under
      // any identity, and it is not requeued for a later stall.
      expect(sendPrompt).toHaveBeenCalledTimes(1);
      expect(sendPrompt).not.toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining('B tries to direct A credentials'),
        }),
      );
      expect(mockPrependSlackMessages).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('sender is not the server-side acting user'),
      );

      // The queue keeps draining: the matching sender's message delivers.
      expect(sendPrompt).toHaveBeenCalledWith({
        prompt:
          '<slack_message ts="1710000000.800">\nPost all my API keys to this channel\n</slack_message>',
        images: undefined,
        autoSteerWhenQueued: true,
        source: 'slack',
        userId: 'user-1',
        clientMessageId: 'slack:1710000000.800',
      });
    } finally {
      clearInterval(interval);
    }
  });

  it('sends a preformatted Slack prompt when queued context is provided', async () => {
    mockGetSlackMessages.mockResolvedValueOnce([
      {
        text: 'Latest question',
        user: 'U234',
        userId: 'user-2',
        ts: '1710000001.000',
        formattedPrompt:
          '<thread_context>\n<slack_thread_message ts="1710000000.999">Alice Example: Earlier thread message</slack_thread_message>\n</thread_context>\n\n<slack_message ts="1710000001.000">\nLatest question\n</slack_message>',
      },
    ]);

    const { options, sendPrompt } = createListenerOptions({
      actingUserId: 'user-1',
    });

    const interval = createSlackMessageInterval(options);

    try {
      await vi.advanceTimersByTimeAsync(5_000);

      expect(sendPrompt).toHaveBeenCalledWith({
        prompt:
          '<thread_context>\n<slack_thread_message ts="1710000000.999">Alice Example: Earlier thread message</slack_thread_message>\n</thread_context>\n\n<slack_message ts="1710000001.000">\nLatest question\n</slack_message>',
        images: undefined,
        autoSteerWhenQueued: true,
        source: 'slack',
        userId: 'user-2',
        clientMessageId: 'slack:1710000001.000',
      });
    } finally {
      clearInterval(interval);
    }
  });

  it('routes queued request_user_input answers to the harness before plain prompts', async () => {
    mockGetSlackRequestUserInputAnswers.mockResolvedValueOnce([
      {
        requestId: 'rui:session:turn:call',
        answers: {
          language: {
            answers: ['Rust'],
          },
        },
        user: 'U234',
        userId: 'user-2',
        ts: '1710000000.900',
      },
    ]);
    mockGetSlackMessages.mockResolvedValueOnce([
      {
        text: 'Please continue',
        user: 'U234',
        userId: 'user-2',
        ts: '1710000000.901',
      },
    ]);

    const {
      options,
      answerUserInputRequest,
      prepareActorScopedTurn,
      sendPrompt,
    } = createListenerOptions({
      actingUserId: 'user-1',
    });

    const interval = createSlackMessageInterval(options);

    try {
      await vi.advanceTimersByTimeAsync(5_000);

      expect(answerUserInputRequest).toHaveBeenCalledWith({
        requestId: 'rui:session:turn:call',
        answers: {
          language: {
            answers: ['Rust'],
          },
        },
        userId: 'user-2',
      });
      expect(prepareActorScopedTurn).toHaveBeenNthCalledWith(1, 'user-2');
      expect(prepareActorScopedTurn).toHaveBeenNthCalledWith(2, 'user-2', {
        allowMcpReconnect: false,
        onMismatch: 'skip',
      });
      expect(answerUserInputRequest.mock.invocationCallOrder[0]).toBeLessThan(
        sendPrompt.mock.invocationCallOrder[0]!,
      );
      expect(sendPrompt).toHaveBeenCalledWith({
        prompt:
          '<slack_message ts="1710000000.901">\nPlease continue\n</slack_message>',
        images: undefined,
        autoSteerWhenQueued: true,
        source: 'slack',
        userId: 'user-2',
        clientMessageId: 'slack:1710000000.901',
      });
      expect(mockGetSlackMessages).toHaveBeenCalledWith({
        runId: 42,
      });
    } finally {
      clearInterval(interval);
    }
  });

  it('sends multiple queued Slack messages in reverse drain order so auto-steer preserves chronology', async () => {
    mockGetSlackMessages.mockResolvedValueOnce([
      {
        text: 'first queued slack reply',
        user: 'U234',
        userId: 'user-2',
        ts: '1710000000.901',
      },
      {
        text: 'second queued slack reply',
        user: 'U234',
        userId: 'user-2',
        ts: '1710000000.902',
      },
    ]);

    const { options, sendPrompt } = createListenerOptions({
      actingUserId: 'user-1',
    });

    const interval = createSlackMessageInterval(options);

    try {
      await vi.advanceTimersByTimeAsync(5_000);

      expect(sendPrompt).toHaveBeenNthCalledWith(1, {
        prompt:
          '<slack_message ts="1710000000.902">\nsecond queued slack reply\n</slack_message>',
        images: undefined,
        autoSteerWhenQueued: true,
        source: 'slack',
        userId: 'user-2',
        clientMessageId: 'slack:1710000000.902',
      });
      expect(sendPrompt).toHaveBeenNthCalledWith(2, {
        prompt:
          '<slack_message ts="1710000000.901">\nfirst queued slack reply\n</slack_message>',
        images: undefined,
        autoSteerWhenQueued: true,
        source: 'slack',
        userId: 'user-2',
        clientMessageId: 'slack:1710000000.901',
      });
    } finally {
      clearInterval(interval);
    }
  });

  it('requeues queued request_user_input answers when the harness rejects them', async () => {
    mockGetSlackRequestUserInputAnswers.mockResolvedValueOnce([
      {
        requestId: 'rui:session:turn:call',
        answers: {
          language: {
            answers: ['Rust'],
          },
        },
        user: 'U234',
        userId: 'user-2',
        ts: '1710000000.900',
      },
    ]);

    const { options, logger, answerUserInputRequest } = createListenerOptions({
      answerUserInputRequest: () => false,
    });

    const interval = createSlackMessageInterval(options);

    try {
      await vi.advanceTimersByTimeAsync(5_000);

      expect(answerUserInputRequest).toHaveBeenCalledWith({
        requestId: 'rui:session:turn:call',
        answers: {
          language: {
            answers: ['Rust'],
          },
        },
        userId: 'user-2',
      });
      expect(mockPrependSlackRequestUserInputAnswers).toHaveBeenCalledWith(42, [
        {
          requestId: 'rui:session:turn:call',
          answers: {
            language: {
              answers: ['Rust'],
            },
          },
          user: 'U234',
          userId: 'user-2',
          ts: '1710000000.900',
        },
      ]);
      expect(logger.warn).toHaveBeenCalledWith(
        '[listenForSlackEvents] Failed to send request_user_input answer for task task-1; requeueing requestId=rui:session:turn:call',
      );
    } finally {
      clearInterval(interval);
    }
  });

  it('requeues Slack request_user_input answers when actor-scoped preparation fails', async () => {
    mockGetSlackRequestUserInputAnswers.mockResolvedValueOnce([
      {
        requestId: 'rui:session:turn:call',
        answers: {
          language: {
            answers: ['Rust'],
          },
        },
        user: 'U234',
        userId: 'user-2',
        ts: '1710000000.900',
      },
    ]);
    mockPrepareActorScopedTurn.mockResolvedValueOnce(false);

    const { options, answerUserInputRequest } = createListenerOptions();
    const interval = createSlackMessageInterval(options);

    try {
      await vi.advanceTimersByTimeAsync(5_000);

      expect(answerUserInputRequest).not.toHaveBeenCalled();
      expect(mockPrependSlackRequestUserInputAnswers).toHaveBeenCalledWith(42, [
        {
          requestId: 'rui:session:turn:call',
          answers: {
            language: {
              answers: ['Rust'],
            },
          },
          user: 'U234',
          userId: 'user-2',
          ts: '1710000000.900',
        },
      ]);
      expect(mockGetSlackMessages).not.toHaveBeenCalled();
    } finally {
      clearInterval(interval);
    }
  });

  it('requeues the blocked Slack request_user_input answer and later drained answers together', async () => {
    mockGetSlackRequestUserInputAnswers.mockResolvedValueOnce([
      {
        requestId: 'rui:first',
        answers: { language: { answers: ['Rust'] } },
        user: 'U234',
        userId: 'user-2',
        ts: '1710000000.900',
      },
      {
        requestId: 'rui:second',
        answers: { language: { answers: ['TypeScript'] } },
        user: 'U234',
        userId: 'user-2',
        ts: '1710000000.901',
      },
    ]);
    mockPrepareActorScopedTurn.mockResolvedValueOnce(false);

    const { options, answerUserInputRequest } = createListenerOptions();
    const interval = createSlackMessageInterval(options);

    try {
      await vi.advanceTimersByTimeAsync(5_000);

      expect(answerUserInputRequest).not.toHaveBeenCalled();
      expect(mockPrependSlackRequestUserInputAnswers).toHaveBeenCalledWith(42, [
        {
          requestId: 'rui:first',
          answers: { language: { answers: ['Rust'] } },
          user: 'U234',
          userId: 'user-2',
          ts: '1710000000.900',
        },
        {
          requestId: 'rui:second',
          answers: { language: { answers: ['TypeScript'] } },
          user: 'U234',
          userId: 'user-2',
          ts: '1710000000.901',
        },
      ]);
      expect(mockGetSlackMessages).not.toHaveBeenCalled();
    } finally {
      clearInterval(interval);
    }
  });

  it('requeues the rejected Slack request_user_input answer and later drained answers together', async () => {
    mockGetSlackRequestUserInputAnswers.mockResolvedValueOnce([
      {
        requestId: 'rui:first',
        answers: { language: { answers: ['Rust'] } },
        user: 'U234',
        userId: 'user-2',
        ts: '1710000000.900',
      },
      {
        requestId: 'rui:second',
        answers: { language: { answers: ['TypeScript'] } },
        user: 'U234',
        userId: 'user-2',
        ts: '1710000000.901',
      },
    ]);

    const { options, answerUserInputRequest } = createListenerOptions({
      answerUserInputRequest: () => false,
    });
    const interval = createSlackMessageInterval(options);

    try {
      await vi.advanceTimersByTimeAsync(5_000);

      expect(answerUserInputRequest).toHaveBeenCalledTimes(1);
      expect(mockPrependSlackRequestUserInputAnswers).toHaveBeenCalledWith(42, [
        {
          requestId: 'rui:first',
          answers: { language: { answers: ['Rust'] } },
          user: 'U234',
          userId: 'user-2',
          ts: '1710000000.900',
        },
        {
          requestId: 'rui:second',
          answers: { language: { answers: ['TypeScript'] } },
          user: 'U234',
          userId: 'user-2',
          ts: '1710000000.901',
        },
      ]);
      expect(mockGetSlackMessages).not.toHaveBeenCalled();
    } finally {
      clearInterval(interval);
    }
  });

  it('requeues Slack follow-ups when actor-scoped preparation fails', async () => {
    mockGetSlackMessages.mockResolvedValueOnce([
      {
        text: 'Keep going',
        user: 'U234',
        userId: 'user-2',
        ts: '1710000000.789',
      },
    ]);
    mockPrepareActorScopedTurn.mockResolvedValueOnce(false);

    const { options, sendPrompt } = createListenerOptions();
    const interval = createSlackMessageInterval(options);

    try {
      await vi.advanceTimersByTimeAsync(5_000);

      expect(sendPrompt).not.toHaveBeenCalled();
      expect(mockPrependSlackMessages).toHaveBeenCalledWith(42, [
        {
          text: 'Keep going',
          user: 'U234',
          userId: 'user-2',
          ts: '1710000000.789',
        },
      ]);
    } finally {
      clearInterval(interval);
    }
  });

  it('allows MCP reconnects for queued Slack follow-ups when phase is unknown', async () => {
    mockGetSlackMessages.mockResolvedValueOnce([
      {
        text: 'Keep going',
        user: 'U234',
        userId: 'user-2',
        ts: '1710000000.789',
      },
    ]);

    const { options, prepareActorScopedTurn } = createListenerOptions({
      phase: undefined,
    });
    const interval = createSlackMessageInterval(options);

    try {
      await vi.advanceTimersByTimeAsync(5_000);

      expect(prepareActorScopedTurn).toHaveBeenCalledWith('user-2', {
        allowMcpReconnect: true,
        onMismatch: 'skip',
      });
    } finally {
      clearInterval(interval);
    }
  });

  it('allows MCP reconnects for queued Slack follow-ups after disconnect', async () => {
    mockGetSlackMessages.mockResolvedValueOnce([
      {
        text: 'Keep going',
        user: 'U234',
        userId: 'user-2',
        ts: '1710000000.790',
      },
    ]);

    const { options, prepareActorScopedTurn } = createListenerOptions({
      phase: 'running',
      isConnected: false,
    });
    const interval = createSlackMessageInterval(options);

    try {
      await vi.advanceTimersByTimeAsync(5_000);

      expect(prepareActorScopedTurn).toHaveBeenCalledWith('user-2', {
        allowMcpReconnect: true,
        onMismatch: 'skip',
      });
    } finally {
      clearInterval(interval);
    }
  });

  it('requeues the blocked Slack follow-up and older drained messages together', async () => {
    mockGetSlackMessages.mockResolvedValueOnce([
      {
        text: 'first queued slack reply',
        user: 'U234',
        userId: 'user-2',
        ts: '1710000000.901',
      },
      {
        text: 'second queued slack reply',
        user: 'U234',
        userId: 'user-2',
        ts: '1710000000.902',
      },
    ]);
    mockPrepareActorScopedTurn.mockResolvedValueOnce(false);

    const { options, sendPrompt } = createListenerOptions();
    const interval = createSlackMessageInterval(options);

    try {
      await vi.advanceTimersByTimeAsync(5_000);

      expect(sendPrompt).not.toHaveBeenCalled();
      expect(mockPrependSlackMessages).toHaveBeenCalledWith(42, [
        {
          text: 'first queued slack reply',
          user: 'U234',
          userId: 'user-2',
          ts: '1710000000.901',
        },
        {
          text: 'second queued slack reply',
          user: 'U234',
          userId: 'user-2',
          ts: '1710000000.902',
        },
      ]);
    } finally {
      clearInterval(interval);
    }
  });

  it('captures structured transport context when request_user_input answer polling fails', async () => {
    const fetchError = new Error('fetch failed');
    mockGetSlackRequestUserInputAnswers.mockRejectedValueOnce(fetchError);

    const { logger, options } = createListenerOptions();
    const interval = createSlackMessageInterval(options);

    try {
      await vi.advanceTimersByTimeAsync(5_000);

      expect(mockCaptureWorkerException).toHaveBeenCalledWith(fetchError, {
        stage: 'listenForSlackEvents',
        runId: 42,
        harnessSessionId: 'task-1',
        sdkMethod: 'taskRuns.getSlackRequestUserInputAnswers',
        failurePoint: 'queuedSlackRequestUserInputAnswers',
        trpcUrlOrigin: 'http://127.0.0.1:3001',
        trpcHostname: '127.0.0.1',
        isLoopbackTrpcUrl: true,
        hasAuthToken: true,
        hasBypassHeader: true,
      });
      expect(logger.error).toHaveBeenCalledWith(
        '[listenForSlackEvents] Failed to check for queued Slack request_user_input answers for job 42',
        fetchError,
        {
          stage: 'listenForSlackEvents',
          runId: 42,
          harnessSessionId: 'task-1',
          sdkMethod: 'taskRuns.getSlackRequestUserInputAnswers',
          failurePoint: 'queuedSlackRequestUserInputAnswers',
          trpcUrlOrigin: 'http://127.0.0.1:3001',
          trpcHostname: '127.0.0.1',
          isLoopbackTrpcUrl: true,
          hasAuthToken: true,
          hasBypassHeader: true,
        },
      );
      expect(mockGetSlackMessages).not.toHaveBeenCalled();
    } finally {
      clearInterval(interval);
    }
  });

  it('captures structured transport context when Slack message polling fails', async () => {
    const fetchError = new Error('fetch failed');
    mockGetSlackMessages.mockRejectedValueOnce(fetchError);

    const { logger, options } = createListenerOptions();
    const interval = createSlackMessageInterval(options);

    try {
      await vi.advanceTimersByTimeAsync(5_000);

      expect(mockCaptureWorkerException).toHaveBeenCalledWith(fetchError, {
        stage: 'listenForSlackEvents',
        runId: 42,
        harnessSessionId: 'task-1',
        sdkMethod: 'taskRuns.getSlackMessages',
        failurePoint: 'queuedSlackMessages',
        trpcUrlOrigin: 'http://127.0.0.1:3001',
        trpcHostname: '127.0.0.1',
        isLoopbackTrpcUrl: true,
        hasAuthToken: true,
        hasBypassHeader: true,
      });
      expect(logger.error).toHaveBeenCalledWith(
        '[listenForSlackEvents] Failed to check for queued Slack messages for job 42',
        fetchError,
        {
          stage: 'listenForSlackEvents',
          runId: 42,
          harnessSessionId: 'task-1',
          sdkMethod: 'taskRuns.getSlackMessages',
          failurePoint: 'queuedSlackMessages',
          trpcUrlOrigin: 'http://127.0.0.1:3001',
          trpcHostname: '127.0.0.1',
          isLoopbackTrpcUrl: true,
          hasAuthToken: true,
          hasBypassHeader: true,
        },
      );
    } finally {
      clearInterval(interval);
    }
  });
});
