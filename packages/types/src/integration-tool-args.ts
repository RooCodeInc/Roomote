const SECRET_KEY_PATTERN =
  /secret|token|password|api[-_]?key|authorization|credential|private[-_]?key/i;
const DEFAULT_MAX_STRING_LENGTH = 200;
const MAX_DEPTH = 6;
const MAX_COLLECTION_ITEMS = 50;
const MASKED_VALUE = '[value omitted]';

const SECRET_VALUE_PATTERNS = [
  /\bsk-(?:or-)?[A-Za-z0-9_-]{12,}\b/,
  /\bgh[po]_[A-Za-z0-9]{16,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{16,}\b/,
  /\bxox[bpa]-[A-Za-z0-9-]{12,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
];

function hasSecretShapedString(value: string): boolean {
  let candidate = value;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(candidate))) {
      return true;
    }
    try {
      const decoded = decodeURIComponent(candidate.replace(/\+/g, ' '));
      if (decoded === candidate) return false;
      candidate = decoded;
    } catch {
      return false;
    }
  }
  return SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(candidate));
}

/** Scan argument values recursively; field names are deliberately ignored. */
export function hasIntegrationToolSecret(value: unknown): boolean {
  const visited = new WeakSet<object>();
  const visit = (current: unknown): boolean => {
    if (typeof current === 'string') return hasSecretShapedString(current);
    if (!current || typeof current !== 'object') return false;
    if (visited.has(current)) return false;
    visited.add(current);
    return Array.isArray(current)
      ? current.some(visit)
      : Object.values(current as Record<string, unknown>).some(visit);
  };
  return visit(value);
}

function redactValue(
  value: unknown,
  depth: number,
  maxStringLength: number,
  visited: WeakSet<object>,
): unknown {
  if (depth > MAX_DEPTH) return '[truncated]';
  if (typeof value === 'string') {
    if (hasSecretShapedString(value)) return MASKED_VALUE;
    return value.length > maxStringLength
      ? `${value.slice(0, maxStringLength)}…[truncated]`
      : value;
  }
  if (!value || typeof value !== 'object') return value;
  if (visited.has(value)) return '[truncated]';
  visited.add(value);
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_COLLECTION_ITEMS)
      .map((item) => redactValue(item, depth + 1, maxStringLength, visited));
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, MAX_COLLECTION_ITEMS)
      .map(([key, item]) => [
        key,
        SECRET_KEY_PATTERN.test(key)
          ? MASKED_VALUE
          : redactValue(item, depth + 1, maxStringLength, visited),
      ]),
  );
}

/**
 * Shared safe view of integration arguments for judgment, approval cards, and
 * audit summaries. Value-shaped credentials and secret-named fields use a
 * neutral placeholder; callers can choose their own bounded string preview.
 */
export function redactIntegrationToolArgs(
  value: unknown,
  options: { maxStringLength?: number } = {},
): unknown {
  return redactValue(
    value,
    0,
    options.maxStringLength ?? DEFAULT_MAX_STRING_LENGTH,
    new WeakSet(),
  );
}
