/**
 * Converts standard markdown to Slack's mrkdwn format
 */
function convertMarkdownProseToSlack(text: string): string {
  let converted = text;

  // Convert italic (underscore): _text_ stays the same (Slack uses _text_ for italic)

  // Convert bold and asterisk italics in one pass so newly converted bold is
  // not mistaken for italic by a second replacement.
  converted = converted.replace(
    /\*\*(.+?)\*\*|(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g,
    (_match, bold: string | undefined, italic: string | undefined) =>
      bold === undefined ? `_${italic ?? ''}_` : `*${bold}*`,
  );

  // Convert strikethrough: ~~text~~ → ~text~
  converted = converted.replace(/~~(.+?)~~/g, '~$1~');

  // Convert links: [text](url) → <url|text>
  converted = convertMarkdownLinksToSlack(converted);

  return converted;
}

export function convertMarkdownToSlack(text: string): string {
  let converted = '';
  let proseStart = 0;
  let index = 0;

  while (index < text.length) {
    const delimiter = text[index];
    if (delimiter !== '`' && delimiter !== '~') {
      index += 1;
      continue;
    }

    let delimiterLength = 1;
    while (text[index + delimiterLength] === delimiter) {
      delimiterLength += 1;
    }
    const lineStart = text.lastIndexOf('\n', index - 1) + 1;
    const indentation = text.slice(lineStart, index);
    const isFence = delimiterLength >= 3 && /^ {0,3}$/.test(indentation ?? '');
    if (delimiter === '~' && !isFence) {
      index += delimiterLength;
      continue;
    }

    let closingIndex = -1;
    if (isFence) {
      let candidateLineStart = text.indexOf('\n', index + delimiterLength);
      while (candidateLineStart !== -1) {
        candidateLineStart += 1;
        const candidateLineEnd = text.indexOf('\n', candidateLineStart);
        const line = text.slice(
          candidateLineStart,
          candidateLineEnd === -1 ? text.length : candidateLineEnd,
        );
        const match = line.match(/^ {0,3}(`+|~+)\s*$/);
        if (
          match?.[1]?.[0] === delimiter &&
          match[1].length >= delimiterLength
        ) {
          closingIndex = candidateLineStart + line.indexOf(match[1]);
          delimiterLength = match[1].length;
          break;
        }
        candidateLineStart = candidateLineEnd;
      }
    } else {
      const marker = delimiter.repeat(delimiterLength);
      let candidate = text.indexOf(marker, index + delimiterLength);
      while (candidate !== -1) {
        if (
          text[candidate - 1] !== delimiter &&
          text[candidate + delimiterLength] !== delimiter
        ) {
          closingIndex = candidate;
          break;
        }
        candidate = text.indexOf(marker, candidate + delimiterLength);
      }
    }

    if (closingIndex === -1) {
      index += delimiterLength;
      continue;
    }

    converted += convertMarkdownProseToSlack(text.slice(proseStart, index));
    const codeEnd = closingIndex + delimiterLength;
    converted += text.slice(index, codeEnd);
    index = codeEnd;
    proseStart = codeEnd;
  }

  converted += convertMarkdownProseToSlack(text.slice(proseStart));
  return converted;
}

function isConvertibleSlackUrl(rawUrl: string): boolean {
  const url = rawUrl.trim().toLowerCase();
  return (
    url.startsWith('https://') ||
    url.startsWith('http://') ||
    url.startsWith('mailto:') ||
    url.startsWith('tel:') ||
    url.startsWith('ftp://') ||
    url.startsWith('www.')
  );
}

function hasDisallowedSlackUrlChars(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index] ?? '';
    const code = value.charCodeAt(index);
    // < > | plus any whitespace (including non-breaking space and other \s)
    if (code === 60 || code === 62 || code === 124 || char.trim() === '') {
      return true;
    }
  }
  return false;
}

/**
 * Converts markdown link syntax to Slack link syntax.
 *
 * - `[label](target)` -> `<target|label>` for Slack-linkable targets
 * - Non-linkable targets (e.g. local filesystem paths) are left unchanged
 *
 * The target capture handles one level of balanced parentheses
 * (e.g. Next.js route groups like `(sandbox)`). Labels must not contain
 * square brackets — both character classes are disjoint from their
 * delimiters so matching stays linear on untrusted input.
 */
export function convertMarkdownLinksToSlack(text: string): string {
  return text.replace(
    /\[([^[\]]+)\]\(((?:[^()]|\([^()]*\))+)\)/g,
    (match, label: string, target: string) => {
      if (isConvertibleSlackUrl(target)) {
        return `<${target}|${label}>`;
      }

      return match;
    },
  );
}

function decodeSlackEntity(text: string): string {
  // Decode lt/gt before amp so nested entities are not double-unescaped.
  return text
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

/**
 * Converts Slack mrkdwn link syntax to standard markdown/plain text.
 *
 * - `<https://example.com|label>` -> `[label](https://example.com)`
 * - `<https://example.com>` -> `https://example.com`
 *
 * Other Slack entity forms (mentions/channels) are intentionally untouched.
 * Parsing is a linear left-to-right scan so untrusted payloads cannot drive
 * polynomial regular-expression matching.
 */
export function convertSlackLinksToMarkdown(text: string): string {
  let result = '';
  let index = 0;

  while (index < text.length) {
    if (text.charCodeAt(index) !== 60 /* < */) {
      result += text[index];
      index += 1;
      continue;
    }

    const closeIndex = text.indexOf('>', index + 1);
    if (closeIndex === -1) {
      result += text.slice(index);
      break;
    }

    const inner = text.slice(index + 1, closeIndex);
    const pipeIndex = inner.indexOf('|');

    if (pipeIndex === -1) {
      if (
        inner.length > 0 &&
        !hasDisallowedSlackUrlChars(inner) &&
        isConvertibleSlackUrl(inner)
      ) {
        result += decodeSlackEntity(inner);
        index = closeIndex + 1;
        continue;
      }
    } else {
      const rawUrl = inner.slice(0, pipeIndex);
      const rawLabel = inner.slice(pipeIndex + 1);

      if (
        rawUrl.length > 0 &&
        !hasDisallowedSlackUrlChars(rawUrl) &&
        isConvertibleSlackUrl(rawUrl)
      ) {
        result += `[${decodeSlackEntity(rawLabel)}](${decodeSlackEntity(rawUrl)})`;
        index = closeIndex + 1;
        continue;
      }
    }

    result += text.slice(index, closeIndex + 1);
    index = closeIndex + 1;
  }

  return result;
}
