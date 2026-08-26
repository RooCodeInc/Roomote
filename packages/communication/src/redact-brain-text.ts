/**
 * Deterministic Brain redaction. Patterns mirror the sandbox worker-env scrub
 * list; keep the two in sync when adding a credential shape.
 */
const SECRET_PATTERNS: RegExp[] = [
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g,
];

function findPrivateKeyMarker(
  text: string,
  marker: 'BEGIN' | 'END',
  fromIndex: number,
): { start: number; end: number } | null {
  const prefix = `-----${marker} `;
  let searchFrom = fromIndex;

  while (searchFrom < text.length) {
    const start = text.indexOf(prefix, searchFrom);
    if (start === -1) return null;

    let cursor = start + prefix.length;
    while (cursor < text.length) {
      if (text.startsWith('PRIVATE KEY-----', cursor)) {
        return { start, end: cursor + 'PRIVATE KEY-----'.length };
      }

      const code = text.charCodeAt(cursor);
      if (code !== 32 && (code < 65 || code > 90)) break;
      cursor += 1;
    }

    searchFrom = Math.max(cursor, start + prefix.length);
  }

  return null;
}

function redactPrivateKeys(text: string): string {
  let output = '';
  let cursor = 0;

  while (cursor < text.length) {
    const begin = findPrivateKeyMarker(text, 'BEGIN', cursor);
    if (!begin) return output + text.slice(cursor);

    const end = findPrivateKeyMarker(text, 'END', begin.end);
    if (!end) return output + text.slice(cursor);

    output += `${text.slice(cursor, begin.start)}[REDACTED]`;
    cursor = end.end;
  }

  return output;
}

export function redactBrainText(text: string): string {
  let redacted = redactPrivateKeys(text);

  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, '[REDACTED]');
  }

  return redacted;
}
