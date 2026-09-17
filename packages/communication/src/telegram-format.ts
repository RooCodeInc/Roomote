/**
 * Telegram Bot API text formatting helpers.
 *
 * Plans Telegram Rich Markdown payloads and splits them at Telegram's rich
 * message limit.
 */

export const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;
export const TELEGRAM_MAX_RICH_MESSAGE_LENGTH = 32768;

type MarkdownCodeFence = {
  marker: string;
  length: number;
  openingLine: string;
};

const MARKDOWN_CHUNK_TARGET_LENGTH = 3500;

function escapeTelegramHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
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

  const chunks: string[] = [];
  let remaining = markdown;
  let openFence: MarkdownCodeFence | null = null;

  while (remaining) {
    const prefix = openFence ? `${openFence.openingLine}\n` : '';
    let rawLimit = maxLength - prefix.length;
    let rawChunk = '';
    let nextOpenFence: MarkdownCodeFence | null = null;
    let renderedChunk = '';

    while (rawLimit >= 2) {
      rawChunk = chunkTelegramText(remaining, rawLimit)[0]!;
      nextOpenFence = advanceMarkdownCodeFence(openFence, rawChunk);
      const suffix = nextOpenFence
        ? `${rawChunk.endsWith('\n') ? '' : '\n'}${nextOpenFence.marker.repeat(nextOpenFence.length)}`
        : '';
      renderedChunk = `${prefix}${rawChunk}${suffix}`;
      if (renderedChunk.length <= maxLength) break;
      rawLimit -= renderedChunk.length - maxLength;
    }

    if (!rawChunk || renderedChunk.length > maxLength) {
      throw new Error('Telegram Markdown code fence cannot fit in one chunk.');
    }

    chunks.push(renderedChunk);
    remaining = remaining.slice(rawChunk.length);
    openFence = nextOpenFence;
  }

  return chunks;
}

function advanceMarkdownCodeFence(
  initialFence: MarkdownCodeFence | null,
  markdown: string,
): MarkdownCodeFence | null {
  let openFence = initialFence;
  for (const line of markdown.split('\n')) {
    if (openFence) {
      if (isMarkdownCodeFenceClosing(line, openFence)) openFence = null;
    } else {
      openFence = parseMarkdownCodeFenceOpening(line);
    }
  }
  return openFence;
}

type TelegramRichMarkdownChunk = {
  text: string;
  markdown: string;
};

function renderTelegramPlainText(text: string): string {
  return text
    ? `<p>${escapeTelegramHtml(text).replaceAll('\n', '<br>')}</p>`
    : '';
}

function chunkTelegramPlainTextAsMarkdown(
  text: string,
  maxLength: number,
): TelegramRichMarkdownChunk[] {
  const markdown = renderTelegramPlainText(text);
  if (markdown.length <= maxLength) return [{ text, markdown }];

  const targetLength = Math.max(
    2,
    Math.min(
      text.length - 1,
      Math.floor((text.length * maxLength) / markdown.length / 2),
    ),
  );
  if (targetLength >= text.length) {
    throw new Error('Telegram rich-message content cannot fit in one chunk.');
  }
  return chunkTelegramText(text, targetLength).flatMap((chunk) =>
    chunkTelegramPlainTextAsMarkdown(chunk, maxLength),
  );
}

export type TelegramInputRichMessage = { markdown: string };

type TelegramRichMessageChunk = {
  text: string;
  richMessage: TelegramInputRichMessage;
};

function parseMarkdownCodeFenceOpening(line: string): MarkdownCodeFence | null {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
  const marker = match?.[1];
  if (!marker || (marker[0] === '`' && match[2]?.includes('`'))) return null;
  return {
    marker: marker[0]!,
    length: marker.length,
    openingLine: line,
  };
}

function isMarkdownCodeFenceClosing(
  line: string,
  openFence: MarkdownCodeFence,
): boolean {
  const marker = /^ {0,3}(`{3,}|~{3,})[ \t]*$/u.exec(line)?.[1];
  return marker?.[0] === openFence.marker && marker.length >= openFence.length;
}

function closeOpenMarkdownCodeFence(markdown: string): string {
  const openFence = advanceMarkdownCodeFence(null, markdown);
  return openFence
    ? `${markdown}${markdown.endsWith('\n') ? '' : '\n'}${openFence.marker.repeat(openFence.length)}`
    : markdown;
}

function telegramFooterMarkdownToHtml(markdown: string): string {
  return escapeTelegramHtml(markdown).replace(
    /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_match, label: string, url: string) => `<a href="${url}">${label}</a>`,
  );
}

export function planTelegramRichMessages(input: {
  text: string;
  htmlText?: string;
  footerText?: string;
  footerHtmlText?: string;
  textFormat?: 'plain' | 'markdown';
}): TelegramRichMessageChunk[] {
  const footerHtml = input.footerText
    ? `<footer>${
        input.footerHtmlText ?? telegramFooterMarkdownToHtml(input.footerText)
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
        richMessage: { markdown: `${input.htmlText}${footerSuffix}` },
      },
    ];
  }

  if (input.textFormat === 'markdown') {
    const markdownBody = footerSuffix
      ? closeOpenMarkdownCodeFence(input.text)
      : input.text;
    const chunks =
      markdownBody.length <= bodyLimit
        ? [{ text: input.text, markdown: markdownBody }]
        : chunkTelegramMarkdown(markdownBody, bodyLimit).map((text) => ({
            text,
            markdown: text,
          }));
    const lastIndex = chunks.length - 1;
    return chunks.map((chunk, index) => {
      const markdown =
        index === lastIndex && footerSuffix
          ? closeOpenMarkdownCodeFence(chunk.markdown)
          : chunk.markdown;
      return {
        text: chunk.text,
        richMessage: {
          markdown: `${markdown}${index === lastIndex ? footerSuffix : ''}`,
        },
      };
    });
  }

  const chunks = chunkTelegramPlainTextAsMarkdown(input.text, bodyLimit);
  const lastIndex = chunks.length - 1;
  return chunks.map((chunk, index) => ({
    text: chunk.text,
    richMessage: {
      markdown: `${chunk.markdown}${index === lastIndex ? footerSuffix : ''}`,
    },
  }));
}
