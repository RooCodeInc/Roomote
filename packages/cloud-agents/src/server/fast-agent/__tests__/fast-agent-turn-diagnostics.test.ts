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
    diagnostics.markInferenceStarted();
    currentTime = 1_055;
    diagnostics.recordOpenCodeProviderRetry(2);
    currentTime = 1_100;
    diagnostics.markInferenceFinished();
    currentTime = 1_110;
    diagnostics.finish();

    expect(logger.info).toHaveBeenCalledOnce();
    const logMessage = String(logger.info.mock.calls[0]?.[0]);
    expect(logMessage).toContain('serviceDurationMs=110');
    expect(logMessage).toContain('preInferenceDurationMs=10');
    expect(logMessage).toContain('conversationQueueDurationMs=30');
    expect(logMessage).toContain('inferenceDurationMs=60');
    expect(logMessage).toContain('postInferenceDurationMs=10');
    expect(logMessage).toContain('firstOpenCodeProviderRetryElapsedMs=15');
    expect(logMessage).toContain('lastOpenCodeProviderRetryElapsedMs=15');
  });

  it('records completed and still-active native tools without their payloads', () => {
    let currentTime = 2_000;
    const { diagnostics, logger } = createTestDiagnostics(() => currentTime);

    const finishReply = diagnostics.recordNativeToolStarted('send_chat_reply');
    currentTime = 2_025;
    finishReply();
    diagnostics.recordNativeToolStarted('manage_tasks');
    currentTime = 2_040;
    diagnostics.finish();

    const logMessage = String(logger.info.mock.calls[0]?.[0]);
    expect(logMessage).toContain(
      'nativeToolCallCount=2 completedNativeToolCallCount=1',
    );
    expect(logMessage).toContain(
      'nativeToolStats={"send_chat_reply":{"count":1,"totalDurationMs":25,"maxDurationMs":25}}',
    );
    expect(logMessage).toContain('activeNativeToolCounts={"manage_tasks":1}');
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
