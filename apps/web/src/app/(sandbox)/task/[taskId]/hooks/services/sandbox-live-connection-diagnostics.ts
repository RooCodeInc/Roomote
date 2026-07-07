import { isClearlyTerminalReconnectError } from './sandbox-live-retry-policy';

export type SandboxConnectionFailureCategory =
  | 'auth_error'
  | 'backend_unavailable'
  | 'client_reconnect_failed'
  | 'transport_error';

export function classifySandboxConnectionFailureCategory({
  phase,
  reason,
}: {
  phase: 'initial' | 'established';
  reason?: string | null;
}): SandboxConnectionFailureCategory {
  if (reason && isClearlyTerminalReconnectError(reason)) {
    return 'auth_error';
  }

  return phase === 'established'
    ? 'client_reconnect_failed'
    : 'backend_unavailable';
}

export function classifySandboxTransportErrorCategory(
  error: unknown,
): SandboxConnectionFailureCategory {
  return isClearlyTerminalReconnectError(error)
    ? 'auth_error'
    : 'transport_error';
}
