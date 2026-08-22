/**
 * Markdown → Slack `rich_text` conversion for surfaces that take a
 * rich_text entity instead of a `markdown` block (task cards). Covers the
 * inline and block syntax agents actually emit: bold, italic,
 * strikethrough, inline code, links, bullet/numbered lists, headings, and
 * fenced code blocks. Anything else stays literal text.
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

const INLINE_PATTERN =
  /(`[^`\n]+`)|(\*\*[^*\n]+?\*\*)|(__[^_\n]+?__)|(~~[^~\n]+?~~)|(\[[^\]\n]+\]\((?:https?:\/\/)[^)\s]+\))|(<(?:https?:\/\/)[^>\s|]+(?:\|[^>]+)?>)|(\b(?:https?:\/\/)[^\s<>)]+)|((?<![\w*])\*[^*\n]+?\*(?![\w*]))|((?<![\w_])_[^_\n]+?_(?![\w_]))/g;

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
): SlackRichTextInlineElement[] {
  const elements: SlackRichTextInlineElement[] = [];
  let last = 0;

  const pushText = (value: string) => {
    if (value) {
      elements.push(withStyle({ type: 'text', text: value }, style));
    }
  };

  for (const match of text.matchAll(INLINE_PATTERN)) {
    const index = match.index ?? 0;
    pushText(text.slice(last, index));
    last = index + match[0].length;
    const [
      ,
      code,
      boldStars,
      boldUnderscores,
      strike,
      markdownLink,
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
    } else if (boldStars || boldUnderscores) {
      const inner = (boldStars ?? boldUnderscores)!.slice(2, -2);
      elements.push(
        ...convertMarkdownInlineToRichText(inner, { ...style, bold: true }),
      );
    } else if (strike) {
      elements.push(
        ...convertMarkdownInlineToRichText(strike.slice(2, -2), {
          ...style,
          strike: true,
        }),
      );
    } else if (markdownLink) {
      const parsed = markdownLink.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (parsed) {
        elements.push(
          withStyle({ type: 'link', url: parsed[2]!, text: parsed[1]! }, style),
        );
      }
    } else if (slackLink) {
      const [url, label] = slackLink.slice(1, -1).split('|', 2);
      elements.push(
        withStyle(
          { type: 'link', url: url!, ...(label ? { text: label } : {}) },
          style,
        ),
      );
    } else if (bareUrl) {
      elements.push(withStyle({ type: 'link', url: bareUrl }, style));
    } else if (italicStar || italicUnderscore) {
      const inner = (italicStar ?? italicUnderscore)!.slice(1, -1);
      elements.push(
        ...convertMarkdownInlineToRichText(inner, { ...style, italic: true }),
      );
    }
  }

  pushText(text.slice(last));
  return elements;
}

function section(
  text: string,
  style: SlackRichTextStyle = {},
): SlackRichTextSection {
  const elements = convertMarkdownInlineToRichText(text, style);
  return {
    type: 'rich_text_section',
    elements: elements.length > 0 ? elements : [{ type: 'text', text: '' }],
  };
}

const BULLET_ITEM = /^\s*[-*+]\s+(.*)$/;
const ORDERED_ITEM = /^\s*\d+[.)]\s+(.*)$/;
const HEADING = /^\s*#{1,6}\s+(.*)$/;
const FENCE = /^\s*```/;

export function convertMarkdownToRichText(
  markdown: string,
): SlackRichTextValue {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const elements: SlackRichTextBlockElement[] = [];
  let index = 0;

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
      elements.push({
        type: 'rich_text_preformatted',
        elements: [{ type: 'text', text: code.join('\n') }],
      });
      continue;
    }

    const listStyle = BULLET_ITEM.test(line)
      ? 'bullet'
      : ORDERED_ITEM.test(line)
        ? 'ordered'
        : null;
    if (listStyle) {
      const pattern = listStyle === 'bullet' ? BULLET_ITEM : ORDERED_ITEM;
      const items: SlackRichTextSection[] = [];
      while (index < lines.length) {
        const item = lines[index]!.match(pattern);
        if (!item) {
          break;
        }
        items.push(section(item[1]!));
        index += 1;
      }
      elements.push({
        type: 'rich_text_list',
        style: listStyle,
        elements: items,
      });
      continue;
    }

    index += 1;
    if (line.trim().length === 0) {
      continue;
    }

    const heading = line.match(HEADING);
    elements.push(
      heading ? section(heading[1]!, { bold: true }) : section(line.trim()),
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
