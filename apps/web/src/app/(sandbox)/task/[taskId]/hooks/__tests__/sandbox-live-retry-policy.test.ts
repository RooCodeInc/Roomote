import {
  clearSandboxReconnectRetryBudget,
  createSandboxReconnectRetryState,
  isClearlyTerminalReconnectError,
  markSandboxReconnectConnected,
  markSandboxReconnectExhaustionReported,
  planSandboxReconnect,
} from '../services/sandbox-live-retry-policy';

describe('sandbox live retry policy', () => {
  it('allows two initial retries before exhausting the bootstrap budget', () => {
    const initialState = createSandboxReconnectRetryState();
    const firstRetry = planSandboxReconnect(initialState);

    expect(firstRetry).toMatchObject({
      kind: 'retry',
      phase: 'initial',
      delayMs: 1_000,
      attempt: 1,
      maxAttempts: 2,
    });

    const secondRetry = planSandboxReconnect(firstRetry.nextState);

    expect(secondRetry).toMatchObject({
      kind: 'retry',
      phase: 'initial',
      delayMs: 1_000,
      attempt: 2,
      maxAttempts: 2,
    });

    const exhausted = planSandboxReconnect(secondRetry.nextState);

    expect(exhausted).toMatchObject({
      kind: 'exhausted',
      phase: 'initial',
    });
  });

  it('walks the established reconnect delays before surfacing exhaustion', () => {
    let retryState = markSandboxReconnectConnected(
      createSandboxReconnectRetryState(),
    );

    const firstRetry = planSandboxReconnect(retryState);
    retryState = firstRetry.nextState;

    const secondRetry = planSandboxReconnect(retryState);
    retryState = secondRetry.nextState;

    const thirdRetry = planSandboxReconnect(retryState);
    retryState = thirdRetry.nextState;

    const exhausted = planSandboxReconnect(retryState);

    expect(firstRetry).toMatchObject({
      kind: 'retry',
      phase: 'established',
      delayMs: 1_000,
      attempt: 1,
      maxAttempts: 3,
    });
    expect(secondRetry).toMatchObject({
      kind: 'retry',
      phase: 'established',
      delayMs: 2_000,
      attempt: 2,
      maxAttempts: 3,
    });
    expect(thirdRetry).toMatchObject({
      kind: 'retry',
      phase: 'established',
      delayMs: 5_000,
      attempt: 3,
      maxAttempts: 3,
    });
    expect(exhausted).toMatchObject({
      kind: 'exhausted',
      phase: 'established',
    });
  });

  it('preserves the established phase when a manual reconnect clears retry counts', () => {
    const establishedState = markSandboxReconnectConnected(
      createSandboxReconnectRetryState(),
    );
    const clearedState = clearSandboxReconnectRetryBudget(establishedState);
    const retry = planSandboxReconnect(clearedState);

    expect(retry).toMatchObject({
      kind: 'retry',
      phase: 'established',
      delayMs: 1_000,
      attempt: 1,
    });
  });

  it('reports exhaustion once per disconnection episode', () => {
    const initialState = createSandboxReconnectRetryState();

    expect(initialState.hasReportedExhaustion).toBe(false);

    const reportedState = markSandboxReconnectExhaustionReported(initialState);

    expect(reportedState.hasReportedExhaustion).toBe(true);

    // Auto-recovery clears the retry budget before each new chain; the
    // already-reported flag must survive so dead sandboxes do not re-report
    // on every recovery cycle.
    const clearedState = clearSandboxReconnectRetryBudget(reportedState);

    expect(clearedState.hasReportedExhaustion).toBe(true);

    // Only a successful connection starts a fresh episode.
    const connectedState = markSandboxReconnectConnected(clearedState);

    expect(connectedState.hasReportedExhaustion).toBe(false);
  });

  it('detects terminal auth refresh failures', () => {
    expect(isClearlyTerminalReconnectError(new Error('401 unauthorized'))).toBe(
      true,
    );
    expect(isClearlyTerminalReconnectError('403 forbidden')).toBe(true);
    expect(
      isClearlyTerminalReconnectError(
        new Error('sandbox connection refresh timed out'),
      ),
    ).toBe(false);
  });
});
