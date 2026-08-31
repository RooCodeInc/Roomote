/**
 * Markdown → Slack `rich_text` conversion for surfaces that take a
 * rich_text entity instead of a `markdown` block (task cards). Covers the
 * inline and block syntax agents actually emit: `**bold**`, italic,
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

// Every repetition is bounded so a pathological message (for example a
// long run of "[" or "<http://|") cannot make matching superlinear.
const INLINE_PATTERN =
  /(`[^`\n]{1,500}`)|(\*\*[^*\n]{1,500}?\*\*)|(~~[^~\n]{1,500}?~~)|(\[[^\]\n]{1,500}\]\((?:<?https?:\/\/)(?:[^()<>\s]|\([^()<>\s]{0,200}\)){1,2000}>?\))|(<(?:https?:\/\/)[^>\s|]{1,2000}(?:\|[^>\n]{1,500})?>)|(\b(?:https?:\/\/)[^\s<>)]{1,2000})|((?<![\w*])\*(?!\s)[^*\n]{1,500}?(?<!\s)\*(?![\w*]))|((?<![\w_])_(?!\s)[^_\n]{1,500}?(?<!\s)_(?![\w_]))/g;

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

  const pushText = (value: string) => {
    if (!value) {
      return;
    }
    // Adjacent plain text (for example the punctuation trimmed off a bare
    // URL and the prose that follows it) becomes one element.
    const previous = elements[elements.length - 1];
    if (
      previous?.type === 'text' &&
      JSON.stringify(previous.style ?? {}) === JSON.stringify(style)
    ) {
      previous.text += value;
      return;
    }
    elements.push(withStyle({ type: 'text', text: value }, style));
  };

  for (const match of text.matchAll(INLINE_PATTERN)) {
    const index = match.index ?? 0;
    pushText(text.slice(last, index));
    last = index + match[0].length;
    const [
      ,
      code,
      bold,
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
    } else if (markdownLink) {
      // Greedy to the final ")" so balanced parentheses in the URL survive.
      const parsed = markdownLink.match(/^\[([^\]]+)\]\((.+)\)$/);
      if (parsed) {
        const destination = parsed[2]!;
        const hasAngleBrackets =
          destination.startsWith('<') && destination.endsWith('>');
        if (hasAngleBrackets && !options.angleBracketLinkDestinations) {
          pushText(markdownLink);
        } else {
          const url = hasAngleBrackets ? destination.slice(1, -1) : destination;
          elements.push(
            withStyle({ type: 'link', url, text: parsed[1]! }, style),
          );
        }
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

export function convertMarkdownToRichText(
  markdown: string,
  options: SlackRichTextConversionOptions = {},
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
        items.push(section(item[1]!, {}, options));
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
