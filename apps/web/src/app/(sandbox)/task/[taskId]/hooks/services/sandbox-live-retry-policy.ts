const INITIAL_CONNECTION_RETRY_DELAY_MS = 1_000;
const MAX_INITIAL_CONNECTION_RETRIES = 2;
const POST_CONNECT_RETRY_DELAYS_MS = [1_000, 2_000, 5_000] as const;

const TERMINAL_RECONNECT_ERROR_RE =
  /\b(401|403)\b|unauthorized|forbidden|invalid(?: |_)?token|token expired|expired token/i;

interface SandboxReconnectRetryState {
  hasConnectedOnce: boolean;
  initialConnectionRetryCount: number;
  postConnectRetryCount: number;
  /**
   * Whether this disconnection episode already reported an exhausted retry
   * budget. Auto-recovery restarts the retry chain indefinitely, so without
   * this flag a dead sandbox would re-emit the same Sentry event and warning
   * on every recovery cycle. Reset only by a successful connection.
   */
  hasReportedExhaustion: boolean;
}

type SandboxReconnectPlan =
  | {
      kind: 'retry';
      phase: 'initial' | 'established';
      delayMs: number;
      attempt: number;
      maxAttempts: number;
      nextState: SandboxReconnectRetryState;
    }
  | {
      kind: 'exhausted';
      phase: 'initial' | 'established';
      nextState: SandboxReconnectRetryState;
    };

export function createSandboxReconnectRetryState(): SandboxReconnectRetryState {
  return {
    hasConnectedOnce: false,
    initialConnectionRetryCount: 0,
    postConnectRetryCount: 0,
    hasReportedExhaustion: false,
  };
}

export function clearSandboxReconnectRetryBudget(
  state: SandboxReconnectRetryState,
): SandboxReconnectRetryState {
  return {
    ...state,
    initialConnectionRetryCount: 0,
    postConnectRetryCount: 0,
  };
}

export function markSandboxReconnectConnected(
  _state: SandboxReconnectRetryState,
): SandboxReconnectRetryState {
  return {
    hasConnectedOnce: true,
    initialConnectionRetryCount: 0,
    postConnectRetryCount: 0,
    hasReportedExhaustion: false,
  };
}

export function markSandboxReconnectExhaustionReported(
  state: SandboxReconnectRetryState,
): SandboxReconnectRetryState {
  return {
    ...state,
    hasReportedExhaustion: true,
  };
}

export function planSandboxReconnect(
  state: SandboxReconnectRetryState,
): SandboxReconnectPlan {
  if (state.hasConnectedOnce) {
    const delayMs = POST_CONNECT_RETRY_DELAYS_MS[state.postConnectRetryCount];

    if (delayMs === undefined) {
      return {
        kind: 'exhausted',
        phase: 'established',
        nextState: state,
      };
    }

    return {
      kind: 'retry',
      phase: 'established',
      delayMs,
      attempt: state.postConnectRetryCount + 1,
      maxAttempts: POST_CONNECT_RETRY_DELAYS_MS.length,
      nextState: {
        ...state,
        postConnectRetryCount: state.postConnectRetryCount + 1,
      },
    };
  }

  if (state.initialConnectionRetryCount >= MAX_INITIAL_CONNECTION_RETRIES) {
    return {
      kind: 'exhausted',
      phase: 'initial',
      nextState: state,
    };
  }

  return {
    kind: 'retry',
    phase: 'initial',
    delayMs: INITIAL_CONNECTION_RETRY_DELAY_MS,
    attempt: state.initialConnectionRetryCount + 1,
    maxAttempts: MAX_INITIAL_CONNECTION_RETRIES,
    nextState: {
      ...state,
      initialConnectionRetryCount: state.initialConnectionRetryCount + 1,
    },
  };
}

export function isClearlyTerminalReconnectError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : '';

  return TERMINAL_RECONNECT_ERROR_RE.test(message);
}
