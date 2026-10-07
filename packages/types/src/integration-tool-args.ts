import { secretRedactor } from './secret-redaction';
const DEFAULT_MAX_STRING_LENGTH = 200;
const MAX_DEPTH = 6;
const MAX_COLLECTION_ITEMS = 50;
const MASKED_VALUE = '[value omitted]';

const READ_CONTENT_MAX_LENGTH = 4_000;

/** Mask recognized credentials in free text, leaving the rest in place. */
export function maskIntegrationToolText(text: string): string {
  return secretRedactor.maskText(text, { placeholder: MASKED_VALUE });
}

/**
 * Tool results the agent read, prepared for the judgment model: recognized
 * credentials are masked in place (the surrounding text is the evidence) and
 * only the most recent text is kept, since the paused call follows it.
 */
export function boundIntegrationToolReadContent(text: string): string {
  const masked = maskIntegrationToolText(text);
  return masked.length > READ_CONTENT_MAX_LENGTH
    ? `[earlier content omitted]…${masked.slice(-READ_CONTENT_MAX_LENGTH)}`
    : masked;
}

/** Scan argument values recursively; field names are deliberately ignored. */
export function hasIntegrationToolSecret(value: unknown): boolean {
  const visited = new WeakSet<object>();
  const visit = (current: unknown): boolean => {
    if (typeof current === 'string') return secretRedactor.hasSecret(current);
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
    if (secretRedactor.hasSecret(value)) return MASKED_VALUE;
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
        secretRedactor.isSensitiveKey(key, 'integration')
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
