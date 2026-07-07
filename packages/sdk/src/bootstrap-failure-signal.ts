const BOOTSTRAP_FAILURE_SIGNAL_KEY = 'roomoteBootstrapFailure';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function hasBootstrapFailureSignal(artifacts: unknown): boolean {
  if (!isRecord(artifacts)) {
    return false;
  }

  const signal = artifacts[BOOTSTRAP_FAILURE_SIGNAL_KEY];

  return (
    isRecord(signal) &&
    typeof signal.reason === 'string' &&
    signal.reason.length > 0
  );
}

export function withBootstrapFailureSignal(
  artifacts: unknown,
  reason: string,
): Record<string, unknown> {
  const nextArtifacts = isRecord(artifacts) ? { ...artifacts } : {};

  nextArtifacts[BOOTSTRAP_FAILURE_SIGNAL_KEY] = { reason };

  return nextArtifacts;
}
