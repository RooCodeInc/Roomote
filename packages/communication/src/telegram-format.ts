/**
 * Telegram Bot API text formatting helpers.
 *
 * Converts the agent-authored markdown used across Roomote chat surfaces into
 * Telegram rich-message HTML and splits rendered payloads at Telegram's rich
 * message limit.
 */

export const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;
export const TELEGRAM_MAX_RICH_MESSAGE_LENGTH = 32768;

/**
 * Chunk raw markdown before HTML conversion so tag pairs never straddle a
 * message boundary. Keep enough headroom for the HTML tags added later.
 */
const MARKDOWN_CHUNK_TARGET_LENGTH = 3500;

function escapeTelegramHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function convertInlineMarkdown(escaped: string): string {
  return (
    escaped
      // Links first so their URLs are not touched by emphasis rules.
      .replace(
        /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
        (_match, label: string, url: string) => `<a href="${url}">${label}</a>`,
      )
      .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
      .replace(/(?<![\w*])\*([^*\n]+)\*(?![\w*])/g, '<i>$1</i>')
      // Underscore italics only when they wrap a whole line, so snake_case
      // identifiers inside prose are never touched.
      .replace(/^_([^_\n](?:[^\n]*[^_\n])?)_$/gm, '<i>$1</i>')
      .replace(/~~([^~\n]+)~~/g, '<s>$1</s>')
  );
}

type MarkdownSegment =
  | { kind: 'text'; content: string }
  | { kind: 'code'; content: string; language?: string };

function splitCodeFences(markdown: string): MarkdownSegment[] {
  const segments: MarkdownSegment[] = [];
  const fencePattern = /^```([^\n`]*)\n([\s\S]*?)^```[ \t]*$/gm;
  let lastIndex = 0;

  for (const match of markdown.matchAll(fencePattern)) {
    const index = match.index ?? 0;

    if (index > lastIndex) {
      segments.push({
        kind: 'text',
        content: markdown.slice(lastIndex, index),
      });
    }

    segments.push({
      kind: 'code',
      content: match[2] ?? '',
      ...(match[1]?.trim() ? { language: match[1].trim() } : {}),
    });
    lastIndex = index + match[0].length;
  }

  if (lastIndex < markdown.length) {
    segments.push({ kind: 'text', content: markdown.slice(lastIndex) });
  }

  return segments;
}

function convertInlineText(escaped: string): string {
  // Convert inline code spans before emphasis so their contents stay verbatim.
  const withInlineCode = escaped.replace(/`([^`\n]+)`/g, '<code>$1</code>');

  // Apply emphasis/link conversion outside <code> spans only.
  return withInlineCode
    .split(/(<code>[^<]*<\/code>)/g)
    .map((part) =>
      part.startsWith('<code>') ? part : convertInlineMarkdown(part),
    )
    .join('');
}

function convertTextSegment(segment: string): string {
  const escaped = escapeTelegramHtml(segment);
  const hasBlockMarkdown =
    segment.includes('\n') || /^(?:#{1,6}|[-+*]|\d+[.)])\s+/u.test(segment);
  if (!hasBlockMarkdown) return convertInlineText(escaped);

  const blocks: string[] = [];
  let paragraphLines: string[] = [];
  let listType: 'ol' | 'ul' | null = null;
  let listItems: string[] = [];

  const flushParagraph = () => {
    if (paragraphLines.length === 0) return;
    blocks.push(`<p>${paragraphLines.map(convertInlineText).join('<br>')}</p>`);
    paragraphLines = [];
  };
  const flushList = () => {
    if (!listType) return;
    blocks.push(
      `<${listType}>${listItems
        .map((item) => `<li>${convertInlineText(item)}</li>`)
        .join('')}</${listType}>`,
    );
    listType = null;
    listItems = [];
  };

  for (const line of escaped.split('\n')) {
    if (line.trim() === '') {
      flushParagraph();
      flushList();
      continue;
    }

    const headingMatch = /^(#{1,6})\s+(.*)$/u.exec(line);
    if (headingMatch) {
      flushParagraph();
      flushList();
      const level = headingMatch[1]!.length;
      blocks.push(
        `<h${level}>${convertInlineText(headingMatch[2]!)}</h${level}>`,
      );
      continue;
    }

    const listMatch = /^(?:[-+*]|(\d+)[.)])\s+(.*)$/u.exec(line);
    if (listMatch) {
      flushParagraph();
      const nextListType = listMatch[1] ? 'ol' : 'ul';
      if (listType && listType !== nextListType) flushList();
      listType = nextListType;
      listItems.push(listMatch[2]!);
      continue;
    }

    flushList();
    paragraphLines.push(line);
  }

  flushParagraph();
  flushList();
  return blocks.join('');
}

/**
 * Convert Roomote markdown to Telegram rich-message HTML. Supports paragraphs,
 * lists, headings, bold, italic, strikethrough, inline code, fenced code blocks,
 * and links. Everything else passes through as escaped text.
 */
export function markdownToTelegramHtml(markdown: string): string {
  return splitCodeFences(markdown)
    .map((segment) => {
      if (segment.kind === 'code') {
        const escaped = escapeTelegramHtml(segment.content.replace(/\n$/, ''));

        return segment.language
          ? `<pre><code class="language-${segment.language}">${escaped}</code></pre>`
          : `<pre>${escaped}</pre>`;
      }

      return convertTextSegment(segment.content);
    })
    .join('');
}

function safeCodePointBoundary(text: string, boundary: number): number {
  const adjustedBoundary =
    boundary > 0 &&
    boundary < text.length &&
    /[\uD800-\uDBFF]/.test(text[boundary - 1] ?? '') &&
    /[\uDC00-\uDFFF]/.test(text[boundary] ?? '')
      ? boundary - 1
      : boundary;

  if (adjustedBoundary > 0) {
    return adjustedBoundary;
  }

  return (text.codePointAt(0) ?? 0) > 0xffff ? 2 : 1;
}

/**
 * Split plain Telegram text without dropping separators or cutting a Unicode
 * code point. Prefer paragraph, line, then word boundaries before hard splits.
 */
export function chunkTelegramText(
  text: string,
  maxLength: number = TELEGRAM_MAX_MESSAGE_LENGTH,
): string[] {
  if (!Number.isSafeInteger(maxLength) || maxLength < 2) {
    throw new Error('Telegram chunk length must be an integer of at least 2.');
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    const hardBoundary = safeCodePointBoundary(remaining, maxLength);
    const candidate = remaining.slice(0, hardBoundary);
    const paragraphIndex = candidate.lastIndexOf('\n\n');
    const paragraphBoundary = paragraphIndex < 0 ? 0 : paragraphIndex + 2;
    const newlineBoundary = candidate.lastIndexOf('\n') + 1;
    let whitespaceBoundary = 0;

    for (let index = candidate.length - 1; index >= 0; index -= 1) {
      if (/\s/u.test(candidate[index] ?? '')) {
        whitespaceBoundary = index + 1;
        break;
      }
    }

    const minimumPreferredBoundary = Math.floor(hardBoundary / 2);
    const boundary =
      [paragraphBoundary, newlineBoundary, whitespaceBoundary].find(
        (value) => value > 0 && value >= minimumPreferredBoundary,
      ) ?? hardBoundary;
    chunks.push(remaining.slice(0, boundary));
    remaining = remaining.slice(boundary);
  }

  if (remaining.length > 0 || chunks.length === 0) {
    chunks.push(remaining);
  }

  return chunks;
}

/**
 * Split markdown into chunks that each convert to a Telegram-safe message.
 * Splits at line boundaries and never inside a fenced code block: a fence
 * that would overflow is closed and reopened in the next chunk.
 */
export function chunkTelegramMarkdown(
  markdown: string,
  maxLength: number = MARKDOWN_CHUNK_TARGET_LENGTH,
): string[] {
  if (markdown.length <= maxLength) {
    return [markdown];
  }

  const rawChunks = chunkTelegramText(markdown, maxLength - 16);
  let openFence: string | null = null;

  return rawChunks.map((rawChunk) => {
    const reopenFence = openFence;

    for (const line of rawChunk.split('\n')) {
      if (/^```/.test(line)) {
        openFence = openFence ? null : line;
      }
    }

    const renderedChunk = reopenFence
      ? `${reopenFence}\n${rawChunk}`
      : rawChunk;

    return openFence
      ? `${renderedChunk}${renderedChunk.endsWith('\n') ? '' : '\n'}\`\`\``
      : renderedChunk;
  });
}

/**
 * HTML escaping and tags can expand a chunk well past its raw markdown
 * length (worst case ~5x for `&`-heavy text), so chunking on raw length
 * alone can still produce messages Telegram rejects as too long. Re-chunk
 * any oversized piece with a target scaled down by its observed expansion
 * ratio. The floor guarantees termination: at 256 raw characters even
 * worst-case escaping plus tag overhead stays below the configured limit.
 */
const HTML_CHUNK_MIN_TARGET_LENGTH = 256;

type TelegramHtmlChunk = {
  markdown: string;
  html: string;
};

function convertChunkWithinLimit(
  chunk: string,
  targetLength: number,
  maxHtmlLength: number,
): TelegramHtmlChunk[] {
  const html = markdownToTelegramHtml(chunk);

  if (html.length <= maxHtmlLength) {
    return [{ markdown: chunk, html }];
  }

  const scaledTarget = Math.floor(
    (chunk.length * maxHtmlLength) / html.length / 2,
  );
  const nextTarget = Math.max(
    HTML_CHUNK_MIN_TARGET_LENGTH,
    Math.min(Math.floor(targetLength / 2), scaledTarget),
  );
  if (nextTarget >= chunk.length) {
    throw new Error('Telegram rich-message content cannot fit in one chunk.');
  }

  return chunkTelegramMarkdown(chunk, nextTarget).flatMap((piece) =>
    convertChunkWithinLimit(piece, nextTarget, maxHtmlLength),
  );
}

/**
 * Split markdown into send-ready pieces whose converted HTML fits within the
 * requested Telegram rich-message budget.
 */
export function chunkTelegramMarkdownAsHtml(
  markdown: string,
  maxHtmlLength: number = TELEGRAM_MAX_RICH_MESSAGE_LENGTH,
): TelegramHtmlChunk[] {
  if (!Number.isSafeInteger(maxHtmlLength) || maxHtmlLength < 2) {
    throw new Error(
      'Telegram HTML chunk length must be an integer of at least 2.',
    );
  }
  const html = markdownToTelegramHtml(markdown);

  if (html.length <= maxHtmlLength) {
    return [{ markdown, html }];
  }

  const targetLength = Math.max(
    HTML_CHUNK_MIN_TARGET_LENGTH,
    Math.floor(maxHtmlLength * 0.85),
  );
  return chunkTelegramMarkdown(markdown, targetLength).flatMap((chunk) =>
    convertChunkWithinLimit(chunk, targetLength, maxHtmlLength),
  );
}

function chunkTelegramPlainTextAsHtml(
  text: string,
  maxHtmlLength: number,
): TelegramHtmlChunk[] {
  const html = escapeTelegramHtml(text).replaceAll('\n', '<br>');
  if (html.length <= maxHtmlLength) return [{ markdown: text, html }];

  const targetLength = Math.max(
    2,
    Math.min(
      text.length - 1,
      Math.floor((text.length * maxHtmlLength) / html.length / 2),
    ),
  );
  if (targetLength >= text.length) {
    throw new Error('Telegram rich-message content cannot fit in one chunk.');
  }
  return chunkTelegramText(text, targetLength).flatMap((chunk) =>
    chunkTelegramPlainTextAsHtml(chunk, maxHtmlLength),
  );
}

type TelegramRichMessageChunk = {
  text: string;
  html: string;
};

export function planTelegramRichMessages(input: {
  text: string;
  htmlText?: string;
  footerText?: string;
  footerHtmlText?: string;
  textFormat?: 'plain' | 'markdown';
}): TelegramRichMessageChunk[] {
  const footerHtml = input.footerText
    ? `<footer>${
        input.footerHtmlText ?? markdownToTelegramHtml(input.footerText)
      }</footer>`
    : '';
  const footerSuffix = footerHtml ? `\n\n${footerHtml}` : '';
  const bodyLimit = TELEGRAM_MAX_RICH_MESSAGE_LENGTH - footerSuffix.length;
  if (bodyLimit < 2) {
    throw new Error(
      `Telegram rich-message footer exceeds ${TELEGRAM_MAX_RICH_MESSAGE_LENGTH} characters.`,
    );
  }

  if (input.htmlText !== undefined && input.htmlText.length <= bodyLimit) {
    return [
      {
        text: input.text,
        html: `${input.htmlText}${footerSuffix}`,
      },
    ];
  }

  const chunks =
    input.textFormat === 'markdown'
      ? chunkTelegramMarkdownAsHtml(input.text, bodyLimit)
      : chunkTelegramPlainTextAsHtml(input.text, bodyLimit);
  const lastIndex = chunks.length - 1;
  return chunks.map((chunk, index) => ({
    text: chunk.markdown,
    html: `${chunk.html}${index === lastIndex ? footerSuffix : ''}`,
  }));
}
