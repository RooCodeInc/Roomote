/**
 * Bootstrap (file upload + worker install) runs after an instance exists.
 * Its failures used to fail the run outright even when the instance was
 * fine and only the controller's connection to the provider dropped: a cut
 * exec stream, a reset socket, a proxy 502. Those say nothing about the next
 * instance, so the creators retry the whole create-and-bootstrap sequence a
 * bounded number of times for transport-shaped errors only. An install
 * script that exits non-zero is deterministic and is never retried.
 */
export const MAX_BOOTSTRAP_ATTEMPTS = 3;
export const BOOTSTRAP_RETRY_DELAY_MS = 2_000;

const TRANSIENT_STATUS_CODES = new Set([502, 503, 504]);

const TRANSIENT_MESSAGE_PATTERNS: readonly RegExp[] = [
  /\bterminated\b/i,
  /\bECONNRESET\b/,
  /\bECONNREFUSED\b/,
  /\bEPIPE\b/,
  /\bETIMEDOUT\b/,
  /\bEAI_AGAIN\b/,
  /socket hang up/i,
  /fetch failed/i,
  /other side closed/i,
  /\bUND_ERR_/,
  /connection (?:reset|closed|refused)/i,
  /premature(?:ly)? clos/i,
  /Broker exec error/i,
  /\b(?:502|503|504)\b/,
  /bad gateway|service unavailable|gateway time-?out/i,
];

const DETERMINISTIC_MESSAGE_PATTERNS: readonly RegExp[] = [
  /install failed with exit code/i,
];

function collectErrorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current: unknown = error;

  while (current && chain.length < 6 && !chain.includes(current)) {
    chain.push(current);
    current =
      typeof current === 'object' && current !== null && 'cause' in current
        ? (current as { cause?: unknown }).cause
        : undefined;
  }

  return chain;
}

function describe(value: unknown): string {
  if (value instanceof Error) {
    const code = (value as Error & { code?: unknown }).code;
    return `${value.name} ${value.message} ${typeof code === 'string' ? code : ''}`;
  }

  return typeof value === 'string' ? value : String(value);
}

export function isTransientBootstrapError(error: unknown): boolean {
  const chain = collectErrorChain(error);

  for (const entry of chain) {
    const text = describe(entry);

    if (DETERMINISTIC_MESSAGE_PATTERNS.some((pattern) => pattern.test(text))) {
      return false;
    }
  }

  for (const entry of chain) {
    const status =
      typeof entry === 'object' && entry !== null
        ? ((entry as { status?: unknown; statusCode?: unknown }).status ??
          (entry as { statusCode?: unknown }).statusCode)
        : undefined;

    if (typeof status === 'number' && TRANSIENT_STATUS_CODES.has(status)) {
      return true;
    }

    const text = describe(entry);

    if (TRANSIENT_MESSAGE_PATTERNS.some((pattern) => pattern.test(text))) {
      return true;
    }
  }

  return false;
}
