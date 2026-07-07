const OPENAI_CITATION_UNICODE = /\uE200cite(?:\uE202\S+)+\uE201?/g;

const BARE_CITATION_IDS =
  /(^|[\s([{"'])(?:cite)?(?:turn\d+[a-z]+\d+)+(?=$|[\s)\]},."'!?;:])/g;

const CITATION_SENTINEL = '\u0000';
const CONSECUTIVE_SENTINELS = new RegExp(
  `${CITATION_SENTINEL}(?:[ \\t]*${CITATION_SENTINEL})+`,
  'g',
);
const CITATION_SENTINEL_SPAN = new RegExp(
  `([ \\t]*)${CITATION_SENTINEL}([ \\t]*)`,
  'g',
);
const SPACE_BEFORE_CITATION = /[\p{L}\p{N}_\])}"'.!?;:,]/u;
const SPACE_AFTER_CITATION = /[\p{L}\p{N}_([{'"`]/u;

export function stripLlmCitationArtifacts(text: string): string {
  return text
    .replace(OPENAI_CITATION_UNICODE, CITATION_SENTINEL)
    .replace(BARE_CITATION_IDS, `$1${CITATION_SENTINEL}`)
    .replace(CONSECUTIVE_SENTINELS, CITATION_SENTINEL)
    .replace(
      CITATION_SENTINEL_SPAN,
      (match, leadingWhitespace, trailingWhitespace, offset, input) => {
        // Preserve the larger surrounding whitespace span so tabs, double-spaces,
        // and trailing whitespace survive citation removal.
        if (offset === 0) {
          return '';
        }

        if (offset + match.length === input.length) {
          return trailingWhitespace;
        }

        const previousChar = input[offset - 1] ?? '';
        const nextChar = input[offset + match.length] ?? '';

        if (
          SPACE_BEFORE_CITATION.test(previousChar) &&
          SPACE_AFTER_CITATION.test(nextChar)
        ) {
          if (
            leadingWhitespace.length === 0 &&
            trailingWhitespace.length === 0
          ) {
            return ' ';
          }

          return leadingWhitespace.length >= trailingWhitespace.length
            ? leadingWhitespace
            : trailingWhitespace;
        }

        return '';
      },
    );
}

export function deepStripCitations<T>(value: T): T {
  if (typeof value === 'string') {
    const stripped = stripLlmCitationArtifacts(value);
    return (stripped === value ? value : stripped) as T;
  }

  if (Array.isArray(value)) {
    let changed = false;
    const result = value.map((item) => {
      const next = deepStripCitations(item);
      if (next !== item) changed = true;
      return next;
    });
    return (changed ? result : value) as T;
  }

  if (value && typeof value === 'object') {
    let changed = false;
    const result = Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => {
        const next = deepStripCitations(entry);
        if (next !== entry) changed = true;
        return [key, next];
      }),
    );
    return (changed ? result : value) as T;
  }

  return value;
}
