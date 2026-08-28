const telemetry = vi.hoisted(() => ({
  captureInferenceContext: vi.fn(),
  captureInferenceAttemptOutcome: vi.fn(),
}));

vi.mock('../fast-agent-context-telemetry', () => ({
  captureFastAgentInferenceContext: telemetry.captureInferenceContext,
  captureFastAgentInferenceAttemptOutcome:
    telemetry.captureInferenceAttemptOutcome,
}));

import { FastAgentTurnDiagnostics } from '../fast-agent-turn-diagnostics';

const conversation = {
  surface: 'slack' as const,
  workspaceId: 'team-1',
  conversationId: 'thread-1',
  replyTarget: { channelId: 'channel-1', threadId: 'thread-1' },
};

const inferenceContext = {
  userId: 'user-1',
  sessionId: 'session-1',
  turnId: 'turn-1',
  systemPrompt: 'private system prompt',
  surface: 'slack' as const,
  turnSource: 'human' as const,
  platformEventHandling: 'default' as const,
  platformEventKind: 'delegated_task' as const,
  sessionPath: 'cold_rebuild' as const,
  promptKind: 'bootstrap' as const,
  releasePresent: true,
  environmentCount: 1,
  taskModelCount: 1,
  activeTaskCount: 0,
  integrationCount: 0,
  integrationToolCount: 0,
  memoryIntegrationCount: 0,
  compatibilityMessageCount: 0,
  suppliedThreadMessageCount: 0,
  threadContextAttached: false,
  senderContextPresent: true,
  agentContextPresent: false,
  inputImageCount: 0,
  attachedImageCount: 0,
  degradedComponents: [],
};

function createTestDiagnostics(now: () => number) {
  const logger = {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
  const diagnostics = new FastAgentTurnDiagnostics(
    {
      conversation,
      currentMessageId: 'message-1',
      hasImages: false,
      modelRole: 'primary',
      turnSource: 'human',
    },
    {
      deployMarker: {
        roomote_release: 'release-1',
        roomote_release_source: 'release_version',
      },
      logger,
      now,
    },
  );

  return { diagnostics, logger };
}

describe('FastAgentTurnDiagnostics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('separates session queue wait from provider inference time', () => {
    let currentTime = 1_000;
    const { diagnostics, logger } = createTestDiagnostics(() => currentTime);

    diagnostics.setCanonicalConversationId('canonical-1');
    currentTime = 1_010;
    diagnostics.markInferenceQueued();
    currentTime = 1_040;
    diagnostics.markInferenceSetupStarted();
    const attempt = diagnostics.beginInferenceAttempt(inferenceContext);
    currentTime = 1_060;
    attempt.recordModelResolved('openrouter/openai/gpt-test');
    attempt.recordPromptStarted();
    diagnostics.recordOpenCodeSessionReady('opencode-session-1');
    currentTime = 1_075;
    attempt.recordProviderRetry(2, 'temporary upstream failure');
    currentTime = 1_100;
    attempt.recordSuccess();
    diagnostics.markInferenceFinished();
    currentTime = 1_110;
    diagnostics.finish();

    expect(logger.info).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('[Fast Agent] OpenCode provider retry.'),
    );
    const logMessage = String(logger.info.mock.calls[0]?.[0]);
    expect(logMessage).toContain('serviceDurationMs=110');
    expect(logMessage).toContain('preInferenceDurationMs=10');
    expect(logMessage).toContain('conversationQueueDurationMs=30');
    expect(logMessage).toContain('inferenceSetupDurationMs=20');
    expect(logMessage).toContain('inferenceDurationMs=40');
    expect(logMessage).toContain('postInferenceDurationMs=10');
    expect(logMessage).toContain('firstOpenCodeProviderRetryElapsedMs=15');
    expect(logMessage).toContain('lastOpenCodeProviderRetryElapsedMs=15');
    expect(logMessage).toContain('sessionPath="cold_rebuild"');
    expect(logMessage).toContain('openCodeSessionId="opencode-session-1"');
    expect(logMessage).toContain('recoveredAfterOpenCodeProviderRetry=true');
    expect(telemetry.captureInferenceContext).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        attemptNumber: 1,
        attemptScope: 'provider_retry',
        providerRetryAttempt: 2,
      }),
    );
    expect(telemetry.captureInferenceAttemptOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        attemptNumber: 1,
        outcome: 'success',
        stage: 'model_generation',
        elapsedMs: 60,
        providerRetryEventCount: 1,
      }),
    );
  });

  it('records bounded redacted context for each failed inference attempt', () => {
    const { diagnostics, logger } = createTestDiagnostics(() => 5_000);
    const secret = 'sk-provider-secret-1234567890';

    diagnostics.setCanonicalConversationId('canonical-1');
    const attempt = diagnostics.beginInferenceAttempt(inferenceContext);
    attempt.recordModelResolved('openrouter/openai/gpt-test');
    attempt.recordFailure({
      reason: 'endpoint_unreachable',
      retryable: true,
      error: new Error(`authorization: Bearer ${secret}`),
    });

    expect(logger.warn).toHaveBeenCalledOnce();
    const logMessage = String(logger.warn.mock.calls[0]?.[0]);
    expect(logMessage).toContain('[Fast Agent] Inference attempt failed.');
    expect(logMessage).toContain('attemptNumber=1');
    expect(logMessage).toContain('stage="opencode_setup"');
    expect(logMessage).toContain('reason="endpoint_unreachable"');
    expect(logMessage).toContain('providerRetryEventCount=0');
    expect(logMessage).toContain('[redacted]');
    expect(logMessage).not.toContain(secret);
    expect(telemetry.captureInferenceAttemptOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        attemptNumber: 1,
        outcome: 'failure',
        stage: 'opencode_setup',
        failureReason: 'endpoint_unreachable',
      }),
    );
  });

  it('derives model-resolution and generation failure stages per attempt', () => {
    let currentTime = 6_000;
    const { diagnostics } = createTestDiagnostics(() => currentTime);

    const modelResolutionAttempt =
      diagnostics.beginInferenceAttempt(inferenceContext);
    currentTime = 6_010;
    modelResolutionAttempt.recordFailure({
      reason: 'model_unavailable',
      retryable: false,
      error: new Error('model unavailable'),
    });

    const generationAttempt = diagnostics.beginInferenceAttempt({
      ...inferenceContext,
      sessionPath: 'warm',
      promptKind: 'turn_delta',
    });
    generationAttempt.recordModelResolved('openrouter/openai/gpt-test');
    generationAttempt.recordPromptStarted();
    currentTime = 6_025;
    generationAttempt.recordFailure({
      reason: 'provider_error',
      retryable: true,
      error: new Error('provider error'),
    });

    expect(telemetry.captureInferenceAttemptOutcome).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        attemptNumber: 1,
        stage: 'model_resolution',
        elapsedMs: 10,
      }),
    );
    expect(telemetry.captureInferenceAttemptOutcome).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        attemptNumber: 2,
        sessionPath: 'warm',
        promptKind: 'turn_delta',
        stage: 'model_generation',
        elapsedMs: 15,
      }),
    );
  });

  it('records completed and still-active native tools without their payloads', () => {
    let currentTime = 2_000;
    const { diagnostics, logger } = createTestDiagnostics(() => currentTime);

    const finishReply = diagnostics.recordNativeToolStarted('send_chat_reply');
    currentTime = 2_025;
    finishReply();
    diagnostics.recordNativeToolStarted('launch_task');
    currentTime = 2_040;
    diagnostics.finish();

    const logMessage = String(logger.info.mock.calls[0]?.[0]);
    expect(logMessage).toContain(
      'nativeToolCallCount=2 completedNativeToolCallCount=1',
    );
    expect(logMessage).toContain(
      'nativeToolStats={"send_chat_reply":{"count":1,"totalDurationMs":25,"maxDurationMs":25}}',
    );
    expect(logMessage).toContain('activeNativeToolCounts={"launch_task":1}');
  });

  it('redacts and bounds provider errors before writing them', () => {
    let currentTime = 3_000;
    const { diagnostics, logger } = createTestDiagnostics(() => currentTime);
    const secret = 'sk-provider-secret-1234567890';
    const oversizedDetail = 'x'.repeat(5_000);

    diagnostics.recordFailure(
      'provider_error',
      new Error(`authorization: Bearer ${secret} ${oversizedDetail}`),
    );
    currentTime = 3_010;
    diagnostics.finish();

    expect(logger.error).toHaveBeenCalledOnce();
    const logMessage = String(logger.error.mock.calls[0]?.[0]);
    expect(logMessage).toContain('outcome="failure" reason="provider_error"');
    expect(logMessage).toContain('[redacted]');
    expect(logMessage).not.toContain(secret);
    expect(logMessage.length).toBeLessThan(5_000);
  });

  it('never lets diagnostic logger failures replace the turn result', () => {
    let currentTime = 4_000;
    const logger = {
      error: vi.fn(),
      info: vi.fn(() => {
        throw new Error('logger unavailable');
      }),
      warn: vi.fn(),
    };
    const diagnostics = new FastAgentTurnDiagnostics(
      {
        conversation,
        hasImages: false,
        modelRole: 'primary',
        turnSource: 'human',
      },
      { deployMarker: {}, logger, now: () => currentTime },
    );

    currentTime = 4_010;
    expect(() => diagnostics.finish()).not.toThrow();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to record turn diagnostics'),
    );
  });
});
