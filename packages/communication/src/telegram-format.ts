/**
 * Telegram Bot API text formatting helpers.
 *
 * Converts the agent-authored markdown used across Roomote chat surfaces into
 * the HTML subset supported by Telegram's `parse_mode: 'HTML'`
 * (https://core.telegram.org/bots/api#html-style) and splits long messages so
 * each `sendMessage` call stays under Telegram's 4096-character limit.
 */

export const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

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

function convertTextSegment(segment: string): string {
  const escaped = escapeTelegramHtml(segment);
  const lines = escaped.split('\n').map((line) => {
    const headingMatch = /^(#{1,6})\s+(.*)$/.exec(line);

    if (headingMatch) {
      return `<b>${headingMatch[2]}</b>`;
    }

    return line;
  });

  // Convert inline code spans before emphasis so their contents stay verbatim.
  const withInlineCode = lines
    .join('\n')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>');

  // Apply emphasis/link conversion outside <code> spans only.
  return withInlineCode
    .split(/(<code>[^<]*<\/code>)/g)
    .map((part) =>
      part.startsWith('<code>') ? part : convertInlineMarkdown(part),
    )
    .join('');
}

/**
 * Convert Roomote markdown to Telegram HTML. Supports bold, italic,
 * strikethrough, inline code, fenced code blocks, links, and headings
 * (rendered bold). Everything else passes through as escaped text.
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

function splitLongLine(line: string, maxLength: number): string[] {
  const pieces: string[] = [];

  for (let index = 0; index < line.length; index += maxLength) {
    pieces.push(line.slice(index, index + maxLength));
  }

  return pieces;
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

  const chunks: string[] = [];
  let current: string[] = [];
  let currentLength = 0;
  let openFence: string | null = null;

  const flush = (reopenFence: boolean) => {
    if (currentLength === 0) {
      return;
    }

    if (openFence && reopenFence) {
      current.push('```');
    }

    chunks.push(current.join('\n'));
    current = openFence && reopenFence ? [openFence] : [];
    currentLength = current.join('\n').length;
  };

  for (const rawLine of markdown.split('\n')) {
    const lines =
      rawLine.length > maxLength
        ? splitLongLine(rawLine, maxLength - 8)
        : [rawLine];

    for (const line of lines) {
      const fenceMatch = /^```/.test(line);
      // Reserve room for the closing fence a flush would append.
      const closingFenceReserve = openFence ? 4 : 0;

      if (currentLength + line.length + 1 + closingFenceReserve > maxLength) {
        flush(true);
      }

      current.push(line);
      currentLength += line.length + 1;

      if (fenceMatch) {
        openFence = openFence ? null : line;
      }
    }
  }

  flush(false);

  return chunks.filter((chunk) => chunk.trim().length > 0);
}

/**
 * HTML escaping and tags can expand a chunk well past its raw markdown
 * length (worst case ~5x for `&`-heavy text), so chunking on raw length
 * alone can still produce messages Telegram rejects as too long. Re-chunk
 * any oversized piece with a target scaled down by its observed expansion
 * ratio. The floor guarantees termination: at 256 raw characters even
 * worst-case escaping plus tag overhead stays far below the 4096 limit.
 */
const HTML_CHUNK_MIN_TARGET_LENGTH = 256;

type TelegramHtmlChunk = {
  markdown: string;
  html: string;
};

function convertChunkWithinLimit(
  chunk: string,
  targetLength: number,
): TelegramHtmlChunk[] {
  const html = markdownToTelegramHtml(chunk);

  if (html.length <= TELEGRAM_MAX_MESSAGE_LENGTH) {
    return [{ markdown: chunk, html }];
  }

  const scaledTarget = Math.floor(
    (chunk.length * TELEGRAM_MAX_MESSAGE_LENGTH) / html.length / 2,
  );
  const nextTarget = Math.max(
    HTML_CHUNK_MIN_TARGET_LENGTH,
    Math.min(Math.floor(targetLength / 2), scaledTarget),
  );

  return chunkTelegramMarkdown(chunk, nextTarget).flatMap((piece) =>
    convertChunkWithinLimit(piece, nextTarget),
  );
}

/**
 * Split markdown into send-ready pieces whose *converted HTML* fits within
 * Telegram's message limit. Each piece carries its raw markdown alongside so
 * callers can fall back to plain text when Telegram rejects entity parsing.
 */
export function chunkTelegramMarkdownAsHtml(
  markdown: string,
): TelegramHtmlChunk[] {
  return chunkTelegramMarkdown(markdown).flatMap((chunk) =>
    convertChunkWithinLimit(chunk, MARKDOWN_CHUNK_TARGET_LENGTH),
  );
}
