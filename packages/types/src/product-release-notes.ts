const STUB_MARKER = /REPLACE ME/i;
const RELEASE_HEADING_PATTERN =
  /^##\s+v?(\d+\.\d+\.\d+(?:-[\w.]+)?)(?:\s+\([^)]*\))?\s*$/i;

export type ParsedReleaseNotes = {
  summary: string | null;
  highlights: string[];
  detailsMarkdown: string;
};

export type ParsedProductRelease = ParsedReleaseNotes & { version: string };

function stripLeadingVersionHeading(lines: string[]): string[] {
  if (!/^##\s+v?\d/.test(lines[0] ?? '')) return lines;

  const rest = lines.slice(1);
  while (rest[0]?.trim() === '') rest.shift();
  return rest;
}

function extractBullets(lines: string[]): string[] {
  return lines.flatMap((line) => {
    const text = line.match(/^\s*-\s+(.+)\s*$/)?.[1]?.trim();
    return text && !STUB_MARKER.test(text) ? [text] : [];
  });
}

export function parseReleaseBody(
  body: string | null | undefined,
): ParsedReleaseNotes {
  if (!body?.trim()) {
    return { summary: null, highlights: [], detailsMarkdown: '' };
  }

  const lines = stripLeadingVersionHeading(
    body.replace(/\r\n/g, '\n').split('\n'),
  );
  const summaryLines: string[] = [];
  let index = 0;
  while (index < lines.length && !/^###\s+/.test(lines[index] ?? '')) {
    summaryLines.push(lines[index] ?? '');
    index += 1;
  }

  const summaryText = summaryLines.join('\n').trim();
  let highlights: string[] = [];
  const details: string[] = [];
  while (index < lines.length) {
    const heading = lines[index] ?? '';
    if (!/^###\s+/.test(heading)) {
      details.push(heading);
      index += 1;
      continue;
    }

    const title = heading
      .replace(/^###\s+/, '')
      .trim()
      .toLowerCase();
    const start = index;
    index += 1;
    while (index < lines.length && !/^###\s+/.test(lines[index] ?? '')) {
      index += 1;
    }
    const block = lines.slice(start, index);
    if (title === 'highlights') highlights = extractBullets(block.slice(1));
    else details.push(...block);
  }

  return {
    summary: summaryText && !STUB_MARKER.test(summaryText) ? summaryText : null,
    highlights,
    detailsMarkdown: details.join('\n').trim(),
  };
}

export function parseProductReleaseHistory(
  changelogMarkdown: string,
): ParsedProductRelease[] {
  const lines = changelogMarkdown.replace(/\r\n/g, '\n').split('\n');
  const releases: ParsedProductRelease[] = [];
  let version: string | null = null;
  let start = -1;

  const appendRelease = (end: number) => {
    if (version && start !== -1) {
      releases.push({
        version,
        ...parseReleaseBody(lines.slice(start, end).join('\n')),
      });
    }
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (!/^##\s+/.test(line)) continue;
    appendRelease(index);
    version = line.match(RELEASE_HEADING_PATTERN)?.[1] ?? null;
    start = version ? index : -1;
  }
  appendRelease(lines.length);
  return releases;
}
