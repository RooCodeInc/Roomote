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

type TextRange = { start: number; end: number };

function findPrivateKeyRanges(text: string): TextRange[] {
  const ranges: TextRange[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const begin = findPrivateKeyMarker(text, 'BEGIN', cursor);
    if (!begin) break;

    const end = findPrivateKeyMarker(text, 'END', begin.end);
    if (!end) break;

    ranges.push({ start: begin.start, end: end.end });
    cursor = end.end;
  }

  return ranges;
}

function redactRanges(
  text: string,
  ranges: TextRange[],
  offset: number,
): string {
  let output = '';
  let cursor = 0;

  for (const range of ranges) {
    const start = Math.max(0, range.start - offset);
    const end = Math.min(text.length, range.end - offset);
    if (start >= end) continue;

    output += `${text.slice(cursor, start)}[REDACTED]`;
    cursor = end;
  }

  return output + text.slice(cursor);
}

function redactPatterns(text: string): string {
  let redacted = text;

  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, '[REDACTED]');
  }

  return redacted;
}

export function redactBrainTextFragments(fragments: string[]): string[] {
  const joined = fragments.join('\n');
  const privateKeyRanges = findPrivateKeyRanges(joined);
  let offset = 0;

  return fragments.map((fragment) => {
    const redacted = redactPatterns(
      redactRanges(fragment, privateKeyRanges, offset),
    );
    offset += fragment.length + 1;
    return redacted;
  });
}

export function redactBrainText(text: string): string {
  return redactBrainTextFragments([text])[0]!;
}
