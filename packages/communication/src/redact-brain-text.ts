import { secretRedactor } from '@roomote/types';

type TextRange = { start: number; end: number };

function redactRanges(
  text: string,
  ranges: TextRange[],
  offset: number,
): string {
  let output = '',
    cursor = 0;
  for (const range of ranges) {
    const start = Math.max(0, range.start - offset);
    const end = Math.min(text.length, range.end - offset);
    if (start >= end) continue;
    output += `${text.slice(cursor, start)}[REDACTED]`;
    cursor = end;
  }
  return output + text.slice(cursor);
}

/** Preserve fragment identity while masking private blocks spanning fragments. */
export function redactBrainTextFragments(fragments: string[]): string[] {
  const privateKeyRanges = secretRedactor.privateKeyRanges(
    fragments.join('\n'),
  );
  let offset = 0;
  return fragments.map((fragment) => {
    const redacted = secretRedactor.maskText(
      redactRanges(fragment, privateKeyRanges, offset),
      { placeholder: '[REDACTED]', policy: 'brain' },
    );
    offset += fragment.length + 1;
    return redacted;
  });
}

export function redactBrainText(text: string): string {
  return redactBrainTextFragments([text])[0]!;
}
