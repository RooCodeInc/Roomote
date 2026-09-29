import { formatReactionEmojiForDisplay } from '@roomote/communication/reaction-emoji';

/**
 * Markdown → Slack `rich_text` conversion for surfaces that take a
 * rich_text entity instead of a `markdown` block (task and automation cards).
 * Covers the inline and block syntax agents actually emit: `**bold**`, italic,
 * strikethrough, inline code, links, bullet/numbered lists, headings, and
 * fenced code blocks. Anything else stays literal text. `__bold__` is
 * deliberately not supported: agent prose mentions Python dunders
 * (`__init__`) far more often than it uses that bold form.
 */

export type SlackRichTextStyle = {
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  code?: boolean;
};

export type SlackRichTextInlineElement =
  | { type: 'text'; text: string; style?: SlackRichTextStyle }
  | { type: 'link'; url: string; text?: string; style?: SlackRichTextStyle };

export type SlackRichTextSection = {
  type: 'rich_text_section';
  elements: SlackRichTextInlineElement[];
};

export type SlackRichTextBlockElement =
  | SlackRichTextSection
  | {
      type: 'rich_text_list';
      style: 'bullet' | 'ordered';
      indent?: number;
      elements: SlackRichTextSection[];
    }
  | {
      type: 'rich_text_preformatted';
      elements: Array<{ type: 'text'; text: string }>;
    };

export interface SlackRichTextValue {
  type: 'rich_text';
  elements: SlackRichTextBlockElement[];
}

type SlackRichTextConversionOptions = {
  angleBracketLinkDestinations?: boolean;
};

// Rich-text text elements do not apply Slack's `:name:` markdown parsing.
const SLACK_EMOJI_SHORTCODE_PATTERN = /:[a-z0-9_+-]+(?:::[a-z0-9_+-]+)*:/giu;

function normalizeKnownSlackEmojiShortcodes(text: string): string {
  return text.replace(SLACK_EMOJI_SHORTCODE_PATTERN, (shortcode) => {
    const display = formatReactionEmojiForDisplay(shortcode);
    return display.startsWith(':') ? shortcode : display;
  });
}

const MAX_INLINE_LINK_LABEL_LENGTH = 500;
const MAX_INLINE_LINK_URL_LENGTH = 2_000;

// Markdown links are scanned separately because link labels can contain
// balanced or escaped square brackets. Every repetition here is bounded so a
// pathological message (for example a long run of "<http://|") cannot make
// matching superlinear.
const INLINE_PATTERN =
  /(`[^`\n]{1,500}`)|(\*\*[^*\n]{1,500}?\*\*)|(~~[^~\n]{1,500}?~~)|(<(?:https?:\/\/)[^>\s|]{1,2000}(?:\|[^>\n]{1,500})?>)|(\b(?:https?:\/\/)[^\s<>)]{1,2000})|((?<![\w*])\*(?!\s)[^*\n]{1,500}?(?<!\s)\*(?![\w*]))|((?<![\w_])_(?!\s)[^_\n]{1,500}?(?<!\s)_(?![\w_]))/g;

type MarkdownLinkMatch = {
  index: number;
  end: number;
  raw: string;
  label: string;
  url: string;
  angleBracketed: boolean;
};

type MarkdownLinkDestination = {
  end: number;
  url: string;
  angleBracketed: boolean;
};

function isHttpMarkdownUrl(value: string): boolean {
  return value.startsWith('https://') || value.startsWith('http://');
}

function decodeMarkdownLinkUrl(value: string): string {
  return value.replaceAll('&amp;', '&');
}

function isValidMarkdownLinkUrl(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > MAX_INLINE_LINK_URL_LENGTH ||
    !isHttpMarkdownUrl(value)
  ) {
    return false;
  }

  let parentheses = 0;
  for (const character of value) {
    if (
      character.trim().length === 0 ||
      character === '<' ||
      character === '>'
    ) {
      return false;
    }
    if (character === '(') {
      parentheses += 1;
    } else if (character === ')') {
      if (parentheses === 0) return false;
      parentheses -= 1;
    }
  }

  return parentheses === 0;
}

function parseMarkdownLinkDestination(
  text: string,
  start: number,
): MarkdownLinkDestination | null {
  if (text.startsWith('<', start)) {
    const close = text.indexOf('>', start + 1);
    if (close === -1 || close - start - 1 > MAX_INLINE_LINK_URL_LENGTH) {
      return null;
    }
    const url = decodeMarkdownLinkUrl(text.slice(start + 1, close));
    if (text[close + 1] !== ')' || !isValidMarkdownLinkUrl(url)) {
      return null;
    }
    return { end: close + 2, url, angleBracketed: true };
  }

  if (text.startsWith('&lt;', start)) {
    const close = text.indexOf('&gt;', start + 4);
    if (close === -1 || close - start - 4 > MAX_INLINE_LINK_URL_LENGTH) {
      return null;
    }
    const url = decodeMarkdownLinkUrl(text.slice(start + 4, close));
    if (text[close + 4] !== ')' || !isValidMarkdownLinkUrl(url)) {
      return null;
    }
    return { end: close + 5, url, angleBracketed: true };
  }

  let cursor = start;
  let parentheses = 0;
  while (cursor < text.length && cursor - start < MAX_INLINE_LINK_URL_LENGTH) {
    const character = text[cursor] ?? '';
    if (character === ')' && parentheses === 0) break;
    if (
      character.trim().length === 0 ||
      character === '<' ||
      character === '>'
    ) {
      return null;
    }
    if (character === '(') {
      parentheses += 1;
    } else if (character === ')') {
      parentheses -= 1;
    }
    cursor += 1;
  }

  if (text[cursor] !== ')' || parentheses !== 0) return null;
  const url = decodeMarkdownLinkUrl(text.slice(start, cursor));
  return isValidMarkdownLinkUrl(url)
    ? { end: cursor + 1, url, angleBracketed: false }
    : null;
}

function unescapeMarkdownLinkLabel(label: string): string {
  return label.replace(/\\([\\[\]])/g, '$1');
}

function parseMarkdownLinkAt(
  text: string,
  index: number,
): MarkdownLinkMatch | null {
  if (text[index] !== '[') return null;

  const labelStart = index + 1;
  let cursor = labelStart;
  let bracketDepth = 1;
  let escaped = false;

  while (
    cursor < text.length &&
    cursor - labelStart <= MAX_INLINE_LINK_LABEL_LENGTH
  ) {
    const character = text[cursor] ?? '';
    if (character === '\n') return null;
    if (escaped) {
      escaped = false;
      cursor += 1;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      cursor += 1;
      continue;
    }
    if (character === '[') {
      bracketDepth += 1;
    } else if (character === ']') {
      bracketDepth -= 1;
      if (bracketDepth === 0) break;
    }
    cursor += 1;
  }

  if (
    bracketDepth !== 0 ||
    cursor === labelStart ||
    cursor - labelStart > MAX_INLINE_LINK_LABEL_LENGTH ||
    text[cursor + 1] !== '('
  ) {
    return null;
  }

  const destination = parseMarkdownLinkDestination(text, cursor + 2);
  if (!destination) return null;

  return {
    index,
    end: destination.end,
    raw: text.slice(index, destination.end),
    label: unescapeMarkdownLinkLabel(text.slice(labelStart, cursor)),
    url: destination.url,
    angleBracketed: destination.angleBracketed,
  };
}

function findNextMarkdownLink(
  text: string,
  start: number,
): MarkdownLinkMatch | null {
  let index = text.indexOf('[', start);
  while (index !== -1) {
    const link = parseMarkdownLinkAt(text, index);
    if (link) return link;
    index = text.indexOf('[', index + 1);
  }
  return null;
}

// Sentence punctuation that ends a bare URL belongs to the prose, not the
// link: "see https://a.io/docs." must not link to "docs.".
const BARE_URL_TRAILING_PUNCTUATION = new Set([
  '.',
  ',',
  ';',
  ':',
  '!',
  '?',
  "'",
  '"',
]);

function splitBareUrlTrailingPunctuation(url: string): [string, string] {
  let end = url.length;
  while (end > 0 && BARE_URL_TRAILING_PUNCTUATION.has(url[end - 1]!)) {
    end -= 1;
  }
  return [url.slice(0, end), url.slice(end)];
}

function withStyle(
  element: SlackRichTextInlineElement,
  style: SlackRichTextStyle,
): SlackRichTextInlineElement {
  const merged = { ...(element.style ?? {}), ...style };
  return Object.keys(merged).length > 0
    ? { ...element, style: merged }
    : element;
}

export function convertMarkdownInlineToRichText(
  text: string,
  style: SlackRichTextStyle = {},
  options: SlackRichTextConversionOptions = {},
): SlackRichTextInlineElement[] {
  const elements: SlackRichTextInlineElement[] = [];
  let last = 0;
  let searchIndex = 0;
  let nextMarkdownLink = findNextMarkdownLink(text, searchIndex);
  const inlineMatches = Array.from(text.matchAll(INLINE_PATTERN));
  let inlineMatchIndex = 0;
  let nextInlineMatch = inlineMatches[inlineMatchIndex];

  const pushText = (value: string) => {
    const normalizedValue = normalizeKnownSlackEmojiShortcodes(value);

    if (!normalizedValue) {
      return;
    }
    // Adjacent plain text (for example the punctuation trimmed off a bare
    // URL and the prose that follows it) becomes one element.
    const previous = elements[elements.length - 1];
    if (
      previous?.type === 'text' &&
      JSON.stringify(previous.style ?? {}) === JSON.stringify(style)
    ) {
      previous.text += normalizedValue;
      return;
    }
    elements.push(withStyle({ type: 'text', text: normalizedValue }, style));
  };

  while (nextInlineMatch || nextMarkdownLink) {
    if (nextInlineMatch && (nextInlineMatch.index ?? 0) < searchIndex) {
      inlineMatchIndex += 1;
      nextInlineMatch = inlineMatches[inlineMatchIndex];
      continue;
    }
    if (nextMarkdownLink && nextMarkdownLink.index < searchIndex) {
      nextMarkdownLink = findNextMarkdownLink(text, searchIndex);
    }

    const nextInlineIndex = nextInlineMatch?.index ?? Number.POSITIVE_INFINITY;
    if (nextMarkdownLink && nextMarkdownLink.index < nextInlineIndex) {
      pushText(text.slice(last, nextMarkdownLink.index));
      last = nextMarkdownLink.end;
      searchIndex = last;
      if (
        nextMarkdownLink.angleBracketed &&
        !options.angleBracketLinkDestinations
      ) {
        pushText(nextMarkdownLink.raw);
      } else {
        elements.push(
          withStyle(
            {
              type: 'link',
              url: nextMarkdownLink.url,
              text: normalizeKnownSlackEmojiShortcodes(nextMarkdownLink.label),
            },
            style,
          ),
        );
      }
      nextMarkdownLink = findNextMarkdownLink(text, searchIndex);
      continue;
    }

    if (!nextInlineMatch) break;
    const match = nextInlineMatch;
    const index = match.index ?? 0;
    pushText(text.slice(last, index));
    last = index + match[0].length;
    searchIndex = last;
    inlineMatchIndex += 1;
    nextInlineMatch = inlineMatches[inlineMatchIndex];
    const [
      ,
      code,
      bold,
      strike,
      slackLink,
      bareUrl,
      italicStar,
      italicUnderscore,
    ] = match;

    if (code) {
      elements.push(
        withStyle(
          { type: 'text', text: code.slice(1, -1) },
          { ...style, code: true },
        ),
      );
    } else if (bold) {
      elements.push(
        ...convertMarkdownInlineToRichText(
          bold.slice(2, -2),
          {
            ...style,
            bold: true,
          },
          options,
        ),
      );
    } else if (strike) {
      elements.push(
        ...convertMarkdownInlineToRichText(
          strike.slice(2, -2),
          {
            ...style,
            strike: true,
          },
          options,
        ),
      );
    } else if (slackLink) {
      const [url, label] = slackLink.slice(1, -1).split('|', 2);
      elements.push(
        withStyle(
          {
            type: 'link',
            url: url!,
            ...(label
              ? { text: normalizeKnownSlackEmojiShortcodes(label) }
              : {}),
          },
          style,
        ),
      );
    } else if (bareUrl) {
      const [url, trailing] = splitBareUrlTrailingPunctuation(bareUrl);
      elements.push(withStyle({ type: 'link', url }, style));
      pushText(trailing);
    } else if (italicStar || italicUnderscore) {
      const inner = (italicStar ?? italicUnderscore)!.slice(1, -1);
      elements.push(
        ...convertMarkdownInlineToRichText(
          inner,
          { ...style, italic: true },
          options,
        ),
      );
    }
  }

  pushText(text.slice(last));
  return elements;
}

function section(
  text: string,
  style: SlackRichTextStyle = {},
  options: SlackRichTextConversionOptions = {},
): SlackRichTextSection {
  const elements = convertMarkdownInlineToRichText(text, style, options);
  return {
    type: 'rich_text_section',
    elements: elements.length > 0 ? elements : [{ type: 'text', text: '' }],
  };
}

const BULLET_ITEM = /^\s*[-*+]\s+(.*)$/;
const ORDERED_ITEM = /^\s*\d+[.)]\s+(.*)$/;
const HEADING = /^\s*#{1,6}\s+(.*)$/;
const FENCE = /^\s*```/;

type SlackRichTextListStyle = 'bullet' | 'ordered';

function getListStyle(line: string): SlackRichTextListStyle | null {
  return BULLET_ITEM.test(line)
    ? 'bullet'
    : ORDERED_ITEM.test(line)
      ? 'ordered'
      : null;
}

function listIndent(line: string): number {
  const leadingWhitespace = line.match(/^\s*/)?.[0] ?? '';
  const columns = [...leadingWhitespace].reduce(
    (total, character) => total + (character === '\t' ? 4 : 1),
    0,
  );
  return columns < 2 ? 0 : Math.ceil(columns / 2);
}

export function convertMarkdownToRichText(
  markdown: string,
  options: SlackRichTextConversionOptions = {},
): SlackRichTextValue {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const elements: SlackRichTextBlockElement[] = [];
  let index = 0;
  let pendingBlankLine = false;

  const preservePendingParagraph = () => {
    if (!pendingBlankLine) return;
    const previous = elements.at(-1);
    if (previous?.type === 'rich_text_section') {
      previous.elements.push({ type: 'text', text: '\n\n' });
    } else {
      elements.push({
        type: 'rich_text_section',
        elements: [{ type: 'text', text: '\n\n' }],
      });
    }
    pendingBlankLine = false;
  };

  while (index < lines.length) {
    const line = lines[index]!;

    if (FENCE.test(line)) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !FENCE.test(lines[index]!)) {
        code.push(lines[index]!);
        index += 1;
      }
      index += 1; // closing fence (or end of input)
      preservePendingParagraph();
      elements.push({
        type: 'rich_text_preformatted',
        elements: [{ type: 'text', text: code.join('\n') }],
      });
      continue;
    }

    const listStyle = getListStyle(line);
    if (listStyle) {
      const pattern = listStyle === 'bullet' ? BULLET_ITEM : ORDERED_ITEM;
      const indent = listIndent(line);
      const items: SlackRichTextSection[] = [];
      while (index < lines.length) {
        const itemLine = lines[index]!;
        if (
          getListStyle(itemLine) !== listStyle ||
          listIndent(itemLine) !== indent
        ) {
          break;
        }
        const item = itemLine.match(pattern)!;
        const itemLines = [item[1] ?? ''];
        index += 1;
        while (index < lines.length) {
          const continuation = lines[index]!;
          if (FENCE.test(continuation)) {
            break;
          }
          if (getListStyle(continuation)) {
            break;
          }
          if (continuation.trim().length === 0) {
            let nextIndex = index + 1;
            while (lines[nextIndex]?.trim().length === 0) {
              nextIndex += 1;
            }
            if (getListStyle(lines[nextIndex] ?? '')) {
              break;
            }
            if (/^\s+/.test(lines[nextIndex] ?? '')) {
              itemLines.push('');
              index = nextIndex;
              continue;
            }
            break;
          }
          if (!/^\s+/.test(continuation)) {
            break;
          }
          const value = continuation.trim();
          if (itemLines.length === 1 && itemLines[0]?.trim().length === 0) {
            itemLines[0] = value;
          } else {
            itemLines.push(value);
          }
          index += 1;
        }
        if (itemLines.some((value) => value.trim().length > 0)) {
          items.push(section(itemLines.join('\n'), {}, options));
        }
        if (lines[index]?.trim().length === 0) {
          let nextIndex = index;
          while (lines[nextIndex]?.trim().length === 0) {
            nextIndex += 1;
          }
          if (
            getListStyle(lines[nextIndex] ?? '') === listStyle &&
            listIndent(lines[nextIndex] ?? '') === indent
          ) {
            index = nextIndex;
          }
        }
      }
      preservePendingParagraph();
      if (items.length > 0) {
        elements.push({
          type: 'rich_text_list',
          style: listStyle,
          ...(indent > 0 ? { indent } : {}),
          elements: items,
        });
      }
      continue;
    }

    index += 1;
    if (line.trim().length === 0) {
      if (elements.length > 0) pendingBlankLine = true;
      continue;
    }

    preservePendingParagraph();
    const heading = line.match(HEADING);
    elements.push(
      heading
        ? section(heading[1]!, { bold: true }, options)
        : section(line.trim(), {}, options),
    );
  }

  return {
    type: 'rich_text',
    elements:
      elements.length > 0
        ? elements
        : [
            {
              type: 'rich_text_section',
              elements: [{ type: 'text', text: '' }],
            },
          ],
  };
}
