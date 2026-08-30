import { FastAgentTurnDiagnostics } from '../fast-agent-turn-diagnostics';

const conversation = {
  surface: 'slack' as const,
  workspaceId: 'team-1',
  conversationId: 'thread-1',
  replyTarget: { channelId: 'channel-1', threadId: 'thread-1' },
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
      userId: 'user-1',
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
  it('separates session queue wait from provider inference time', () => {
    let currentTime = 1_000;
    const { diagnostics, logger } = createTestDiagnostics(() => currentTime);

    diagnostics.setCanonicalConversationId('canonical-1');
    currentTime = 1_010;
    diagnostics.markInferenceQueued();
    currentTime = 1_040;
    diagnostics.markInferenceSetupStarted();
    currentTime = 1_060;
    diagnostics.markInferenceStarted();
    currentTime = 1_075;
    diagnostics.recordSessionPath('cold_rebuild');
    diagnostics.recordOpenCodeSessionReady('opencode-session-1');
    diagnostics.recordOpenCodeProviderRetry(2, 'temporary upstream failure');
    diagnostics.recordVisibleReply({ assistantResponse: false });
    currentTime = 1_085;
    diagnostics.recordVisibleReply();
    currentTime = 1_100;
    diagnostics.markInferenceFinished();
    currentTime = 1_110;
    diagnostics.finish();

    expect(logger.info).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('[Fast Agent] OpenCode provider retry.'),
    );
    const logMessage = String(logger.info.mock.calls[0]?.[0]);
    expect(logMessage).toContain('serviceDurationMs=110');
    expect(logMessage).toContain('firstResponseDurationMs=85');
    expect(logMessage).toContain('sandboxlessStartupDurationMs=60');
    expect(logMessage).toContain('inferenceToFirstResponseDurationMs=25');
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
  });

  it('records bounded redacted context for each failed inference attempt', () => {
    const { diagnostics, logger } = createTestDiagnostics(() => 5_000);
    const secret = 'sk-provider-secret-1234567890';

    diagnostics.setCanonicalConversationId('canonical-1');
    diagnostics.recordSessionPath('cold_rebuild');
    diagnostics.recordModelResolved('openrouter/openai/gpt-test');
    diagnostics.recordInferenceAttemptFailure({
      attemptNumber: 1,
      promptKind: 'bootstrap',
      stage: 'opencode_setup',
      elapsedMs: 654,
      reason: 'endpoint_unreachable',
      retryable: true,
      providerRetryEventCount: 0,
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
        userId: 'user-1',
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
