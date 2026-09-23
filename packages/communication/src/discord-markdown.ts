const DEFAULT_DISCORD_MESSAGE_LENGTH = 2_000;

type DiscordFence = {
  character: '`' | '~';
  length: number;
};

function escapeDiscordCodeText(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|#39|apos);|[<>]/giu, (character) => {
    switch (character.toLowerCase()) {
      case '&amp;':
        return '&';
      case '&quot;':
        return '"';
      case '&#39;':
      case '&apos;':
        return "'";
      case '<':
      case '&lt;':
        return '&lt;';
      case '>':
      case '&gt;':
        return '&gt;';
      default:
        return character;
    }
  });
}

function getFenceOpening(line: string): DiscordFence | null {
  const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/u);
  if (!match) return null;
  const marker = match[1]!;
  const character = marker[0] as '`' | '~';
  if (character === '`' && match[2]!.includes('`')) return null;
  return { character, length: marker.length };
}

function isFenceClosing(line: string, fence: DiscordFence): boolean {
  const match = line.match(/^ {0,3}(`+|~+)[ \t]*$/u);
  return Boolean(
    match &&
    match[1]![0] === fence.character &&
    match[1]!.length >= fence.length,
  );
}

function findMatchingBacktickRun(
  text: string,
  from: number,
  runLength: number,
): number {
  for (let index = from; index < text.length;) {
    if (text[index] !== '`') {
      index += 1;
      continue;
    }
    let end = index + 1;
    while (text[end] === '`') end += 1;
    if (end - index === runLength) return index;
    index = end;
  }
  return -1;
}

function isEscapedAt(text: string, index: number): boolean {
  let backslashes = 0;
  for (
    let cursor = index - 1;
    cursor >= 0 && text[cursor] === '\\';
    cursor -= 1
  ) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function parseGfmTableRow(line: string): string[] | null {
  // Four-space indentation and tabs start indented code blocks in Markdown.
  if (/^(?: {4}|\t)/u.test(line)) return null;

  let codeRunLength = 0;
  let precedingBackslashes = 0;
  const separators: number[] = [];

  for (let index = 0; index < line.length;) {
    const character = line[index]!;
    if (character === '\\') {
      precedingBackslashes += 1;
      index += 1;
      continue;
    }

    if (character === '`') {
      let end = index + 1;
      while (line[end] === '`') end += 1;
      const runLength = end - index;
      if (codeRunLength) {
        if (runLength === codeRunLength) codeRunLength = 0;
      } else if (
        precedingBackslashes % 2 === 0 &&
        findMatchingBacktickRun(line, end, runLength) !== -1
      ) {
        codeRunLength = runLength;
      }
      precedingBackslashes = 0;
      index = end;
      continue;
    }

    if (
      character === '|' &&
      codeRunLength === 0 &&
      precedingBackslashes % 2 === 0
    ) {
      separators.push(index);
    }
    precedingBackslashes = 0;
    index += 1;
  }

  if (!separators.length) return null;

  const start = line.search(/\S/u);
  if (start === -1) return null;
  let end = line.length;
  while (end > start && /\s/u.test(line[end - 1]!)) end -= 1;
  const relevantSeparators = separators.filter(
    (separator) => separator >= start && separator < end,
  );
  if (!relevantSeparators.length) return null;

  const cells: string[] = [];
  let previous = start;
  for (const separator of relevantSeparators) {
    cells.push(line.slice(previous, separator).trim());
    previous = separator + 1;
  }
  cells.push(line.slice(previous, end).trim());

  if (relevantSeparators[0] === start) cells.shift();
  if (relevantSeparators.at(-1) === end - 1) cells.pop();
  return cells.length ? cells : null;
}

function findClosingBracket(text: string, start: number): number {
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    if (text[index] === '\\') {
      index += 1;
      continue;
    }
    if (text[index] === '[') depth += 1;
    if (text[index] === ']') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function findClosingParenthesis(text: string, start: number): number {
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    if (text[index] === '\\') {
      index += 1;
      continue;
    }
    if (text[index] === '(') depth += 1;
    if (text[index] === ')') {
      if (depth === 0) return index;
      depth -= 1;
    }
  }
  return -1;
}

function markdownLinkToText(
  label: string,
  destination: string,
  protectUrl: (url: string) => string,
): string {
  let url = destination.trim();
  if (url.startsWith('<') && url.includes('>')) {
    url = url.slice(1, url.indexOf('>'));
  } else {
    const titleStart = url.search(/\s+["'(]/u);
    if (titleStart !== -1) url = url.slice(0, titleStart);
  }
  const plainLabel = plainInlineMarkdown(label);
  return url ? `${plainLabel} (${protectUrl(url)})` : plainLabel;
}

function plainMarkdownSegment(text: string): string {
  let output = '';
  const urls: string[] = [];
  const protectUrl = (url: string) => {
    const index = urls.push(url) - 1;
    return `\uE000${index}\uE001`;
  };
  for (let index = 0; index < text.length;) {
    const image = text[index] === '!' && text[index + 1] === '[';
    const openingBracket = image ? index + 1 : index;
    if (text[openingBracket] !== '[') {
      output += text[index]!;
      index += 1;
      continue;
    }
    const closingBracket = findClosingBracket(text, openingBracket);
    if (closingBracket === -1 || text[closingBracket + 1] !== '(') {
      output += text[index]!;
      index += 1;
      continue;
    }
    const closingParenthesis = findClosingParenthesis(text, closingBracket + 2);
    if (closingParenthesis === -1) {
      output += text[index]!;
      index += 1;
      continue;
    }
    output += markdownLinkToText(
      text.slice(openingBracket + 1, closingBracket),
      text.slice(closingBracket + 2, closingParenthesis),
      protectUrl,
    );
    index = closingParenthesis + 1;
  }

  const plain = output
    .replace(/<((?:https?:\/\/|mailto:)[^>]+)>/giu, (_match, url: string) =>
      protectUrl(url),
    )
    .replace(/(?<!\\)(\*\*|__|~~)(?=\S)([\s\S]*?\S)(?<!\\)\1/gu, '$2')
    .replace(/(?<![\\*])\*(?=\S)([\s\S]*?\S)(?<![\\*])\*(?!\*)/gu, '$1')
    .replace(
      /(?<![\p{L}\p{N}_\\])_(?=\S)([\s\S]*?\S)(?<!\\)_(?![\p{L}\p{N}_])/gu,
      '$1',
    )
    .replace(/\\([^A-Za-z0-9\s])/gu, '$1');
  return plain.replace(
    /\uE000(\d+)\uE001/gu,
    (_match, index: string) => urls[Number(index)] ?? '',
  );
}

function plainInlineMarkdown(text: string): string {
  let output = '';
  let plainSegment = '';

  const flushPlainSegment = () => {
    const plain = plainSegment;
    plainSegment = '';
    output += plainMarkdownSegment(plain);
  };

  for (let index = 0; index < text.length;) {
    if (text[index] !== '`' || isEscapedAt(text, index)) {
      plainSegment += text[index]!;
      index += 1;
      continue;
    }

    let end = index + 1;
    while (text[end] === '`') end += 1;
    const runLength = end - index;
    const closing = findMatchingBacktickRun(text, end, runLength);
    if (closing === -1) {
      plainSegment += text.slice(index, end);
      index = end;
      continue;
    }

    flushPlainSegment();
    let code = text.slice(end, closing);
    if (
      code.length >= 2 &&
      code.startsWith(' ') &&
      code.endsWith(' ') &&
      code.trim()
    ) {
      code = code.slice(1, -1);
    }
    output += code;
    index = closing + runLength;
  }
  flushPlainSegment();
  return escapeDiscordCodeText(output);
}

function longestRun(text: string, character: '`' | '~'): number {
  let longest = 0;
  for (const match of text.matchAll(character === '`' ? /`+/gu : /~+/gu)) {
    longest = Math.max(longest, match[0].length);
  }
  return longest;
}

function selectCodeFence(cells: string[][]): string {
  const content = cells.flat().join('\n');
  const backticks = Math.max(3, longestRun(content, '`') + 1);
  return '`'.repeat(backticks);
}

function wrapCell(text: string, width: number): string[] {
  const lines: string[] = [];
  let remaining = text;
  while (remaining.length > width) {
    let splitAt = remaining.lastIndexOf(' ', width);
    if (splitAt <= 0) splitAt = width;
    lines.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^ /u, '');
  }
  lines.push(remaining);
  return lines;
}

function fitColumnWidths(
  rows: string[][],
  maxLineWidth: number,
): number[] | null {
  const columnCount = rows[0]!.length;
  const availableCellWidth = maxLineWidth - 3 * columnCount - 1;
  const minimumWidths = rows[0]!.map((cell) => Math.max(3, cell.length));
  const minimumWidth = minimumWidths.reduce((sum, width) => sum + width, 0);
  if (availableCellWidth < minimumWidth) return null;

  const maximumWidths = Array.from({ length: columnCount }, (_, column) =>
    Math.max(minimumWidths[column]!, ...rows.map((row) => row[column]!.length)),
  );
  const widths = [...maximumWidths];
  const desiredExtra = widths.map(
    (width, index) => width - minimumWidths[index]!,
  );
  const totalExtra = desiredExtra.reduce((sum, width) => sum + width, 0);
  const extraBudget = availableCellWidth - minimumWidth;
  if (totalExtra <= extraBudget) return widths;
  if (totalExtra === 0) return widths;

  let allocated = 0;
  const fractions: Array<{ index: number; fraction: number }> = [];
  for (let index = 0; index < columnCount; index += 1) {
    const exact = (desiredExtra[index]! * extraBudget) / totalExtra;
    const whole = Math.floor(exact);
    widths[index] = minimumWidths[index]! + whole;
    allocated += whole;
    fractions.push({ index, fraction: exact - whole });
  }
  fractions.sort((left, right) => right.fraction - left.fraction);
  for (let index = 0; allocated < extraBudget; index += 1) {
    const candidate = fractions[index % fractions.length]!.index;
    if (widths[candidate]! < maximumWidths[candidate]!) {
      widths[candidate] = widths[candidate]! + 1;
      allocated += 1;
    }
  }
  return widths;
}

function renderAsciiTable(
  header: string[],
  bodyRows: string[][],
  maxMessageLength: number,
  style: 'grid' | 'compact',
): string | null {
  const columns = header.length;
  const cells = [header, ...bodyRows].map((row) =>
    Array.from({ length: columns }, (_, index) =>
      plainInlineMarkdown(row[index] ?? '')
        .replace(/\t/gu, ' ')
        .trim(),
    ),
  );
  const fence = selectCodeFence(cells);
  if (style === 'compact') {
    const maxLineWidth = maxMessageLength - fence.length * 2 - 2;
    const widths = fitColumnWidths(cells, maxLineWidth + 4);
    if (!widths) return null;
    const renderRow = (row: string[]) => {
      const wrapped = row.map((cell, index) => wrapCell(cell, widths[index]!));
      const height = Math.max(...wrapped.map((column) => column.length));
      return Array.from({ length: height }, (_, line) =>
        wrapped
          .map((column, index) => (column[line] ?? '').padEnd(widths[index]!))
          .join(' | '),
      );
    };
    const compactLines = [
      ...renderRow(cells[0]!),
      widths.map((width) => '-'.repeat(width)).join('-+-'),
    ];
    for (const row of cells.slice(1)) compactLines.push(...renderRow(row));
    return `${fence}\n${compactLines.join('\n')}\n${fence}`;
  }

  const maxLineWidth = Math.floor(
    (maxMessageLength - fence.length * 2 - 12) / 5,
  );
  const widths = fitColumnWidths(cells, maxLineWidth);
  if (!widths) return null;

  const horizontalBorder = (fill: '-' | '=') =>
    `+${widths.map((width) => fill.repeat(width + 2)).join('+')}+`;
  const renderRow = (row: string[]) => {
    const wrapped = row.map((cell, index) => wrapCell(cell, widths[index]!));
    const height = Math.max(...wrapped.map((column) => column.length));
    return Array.from(
      { length: height },
      (_, line) =>
        `| ${wrapped
          .map((column, index) => (column[line] ?? '').padEnd(widths[index]!))
          .join(' | ')} |`,
    );
  };

  const tableLines = [
    horizontalBorder('-'),
    ...renderRow(cells[0]!),
    horizontalBorder('='),
  ];
  for (const row of cells.slice(1)) {
    tableLines.push(...renderRow(row), horizontalBorder('-'));
  }
  return `${fence}\n${tableLines.join('\n')}\n${fence}`;
}

function lineEnding(token: string): string {
  if (!token.endsWith('\n')) return '';
  return token.endsWith('\r\n') ? '\r\n' : '\n';
}

function lineTokens(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
}

function contentOf(token: string): string {
  const withoutLineFeed = token.endsWith('\n') ? token.slice(0, -1) : token;
  return withoutLineFeed.endsWith('\r')
    ? withoutLineFeed.slice(0, -1)
    : withoutLineFeed;
}

/**
 * Converts GFM pipe tables into mobile-independent padded ASCII grids for
 * Discord. Inline Markdown becomes readable plain text inside a code fence.
 */
export function renderDiscordMarkdownTables(
  text: string,
  maxMessageLength = DEFAULT_DISCORD_MESSAGE_LENGTH,
  style: 'grid' | 'compact' = 'grid',
): string {
  const lines = lineTokens(text);
  let output = '';
  let activeFence: DiscordFence | null = null;

  for (let index = 0; index < lines.length;) {
    const current = contentOf(lines[index]!);
    if (activeFence) {
      output += lines[index]!;
      if (isFenceClosing(current, activeFence)) activeFence = null;
      index += 1;
      continue;
    }

    const openingFence = getFenceOpening(current);
    if (openingFence) {
      output += lines[index]!;
      activeFence = openingFence;
      index += 1;
      continue;
    }

    const header = parseGfmTableRow(current);
    const delimiter = lines[index + 1]
      ? parseGfmTableRow(contentOf(lines[index + 1]!))
      : null;
    if (
      header &&
      delimiter &&
      header.length === delimiter.length &&
      delimiter.every((cell) => /^:?-+:?$/u.test(cell))
    ) {
      const bodyRows: string[][] = [];
      let bodyIndex = index + 2;
      let malformed = false;
      while (bodyIndex < lines.length) {
        const bodyLine = contentOf(lines[bodyIndex]!);
        if (!bodyLine.trim()) break;
        const row = parseGfmTableRow(bodyLine);
        if (!row) break;
        if (row.length > header.length) {
          malformed = true;
          break;
        }
        bodyRows.push(
          Array.from(
            { length: header.length },
            (_, column) => row[column] ?? '',
          ),
        );
        bodyIndex += 1;
      }

      if (!malformed && bodyRows.length) {
        const table = renderAsciiTable(
          header,
          bodyRows,
          maxMessageLength,
          style,
        );
        if (table) {
          const eol =
            lineEnding(lines[index]!) ||
            lineEnding(lines[index + 1]!) ||
            lineEnding(lines[bodyIndex - 1]!);
          const tableEnd = lineEnding(lines[bodyIndex - 1]!);
          output += `${table.replaceAll('\n', eol || '\n')}${tableEnd}`;
          index = bodyIndex;
          continue;
        }
      }
    }

    output += lines[index]!;
    index += 1;
  }

  return output;
}
