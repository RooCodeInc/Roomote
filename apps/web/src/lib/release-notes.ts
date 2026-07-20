/**
 * Parse a Roomote GitHub release body (CHANGELOG section) into the fields
 * the in-app what's-new / update-available dialogs render.
 */

const STUB_MARKER = /REPLACE ME/i;

export type ParsedReleaseNotes = {
  summary: string | null;
  highlights: string[];
  detailsMarkdown: string;
};

function isStubText(value: string): boolean {
  return STUB_MARKER.test(value);
}

function stripLeadingVersionHeading(lines: string[]): string[] {
  if (lines.length === 0) {
    return lines;
  }
  if (/^##\s+v?\d/.test(lines[0] ?? '')) {
    const rest = lines.slice(1);
    while (rest.length > 0 && rest[0]?.trim() === '') {
      rest.shift();
    }
    return rest;
  }
  return lines;
}

function extractBullets(blockLines: string[]): string[] {
  const bullets: string[] = [];
  for (const line of blockLines) {
    const match = line.match(/^\s*-\s+(.+)\s*$/);
    if (match?.[1]) {
      const text = match[1].trim();
      if (text && !isStubText(text)) {
        bullets.push(text);
      }
    }
  }
  return bullets;
}

/**
 * Split a release body into summary, Highlights bullets (when present), and
 * the remaining Major/Minor/Patch sections as markdown.
 */
export function parseReleaseBody(
  body: string | null | undefined,
): ParsedReleaseNotes {
  if (!body || !body.trim()) {
    return { summary: null, highlights: [], detailsMarkdown: '' };
  }

  const lines = stripLeadingVersionHeading(
    body.replace(/\r\n/g, '\n').split('\n'),
  );

  let summary: string | null = null;
  const summaryLines: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (/^###\s+/.test(line)) {
      break;
    }
    summaryLines.push(line);
    i += 1;
  }

  const summaryText = summaryLines.join('\n').trim();
  if (summaryText && !isStubText(summaryText)) {
    summary = summaryText;
  }

  let highlights: string[] = [];
  const detailsParts: string[] = [];

  while (i < lines.length) {
    const heading = lines[i] ?? '';
    if (!/^###\s+/.test(heading)) {
      detailsParts.push(heading);
      i += 1;
      continue;
    }

    const headingTitle = heading
      .replace(/^###\s+/, '')
      .trim()
      .toLowerCase();
    const start = i;
    i += 1;
    while (i < lines.length && !/^###\s+/.test(lines[i] ?? '')) {
      i += 1;
    }
    const block = lines.slice(start, i);

    if (headingTitle === 'highlights') {
      highlights = extractBullets(block.slice(1));
      continue;
    }

    detailsParts.push(...block);
  }

  return {
    summary,
    highlights,
    detailsMarkdown: detailsParts.join('\n').trim(),
  };
}
