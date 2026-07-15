/**
 * Converts standard markdown to Slack's mrkdwn format
 */
export function convertMarkdownToSlack(text: string): string {
  let converted = text;

  // Convert bold: **text** → *text*
  converted = converted.replace(/\*\*(.+?)\*\*/g, '*$1*');

  // Convert italic (underscore): _text_ stays the same (Slack uses _text_ for italic)

  // Convert italic (asterisk): *text* → _text_ (but only if not already bold)
  // We need to be careful not to affect our already converted bold
  // This regex looks for single asterisks not preceded by or followed by another asterisk
  converted = converted.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '_$1_');

  // Convert strikethrough: ~~text~~ → ~text~
  converted = converted.replace(/~~(.+?)~~/g, '~$1~');

  // Convert links: [text](url) → <url|text>
  converted = convertMarkdownLinksToSlack(converted);

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
 */
export function convertSlackLinksToMarkdown(text: string): string {
  let converted = text;

  // Convert labeled links first. Scheme checks stay out of the match pattern
  // so untrusted input cannot drive polynomial backoff on scheme alternation.
  converted = converted.replace(
    /<([^<>|\s]+)\|([^>]+)>/g,
    (match, rawUrl: string, rawLabel: string) => {
      if (!isConvertibleSlackUrl(rawUrl)) {
        return match;
      }

      const url = decodeSlackEntity(rawUrl);
      const label = decodeSlackEntity(rawLabel);
      return `[${label}](${url})`;
    },
  );

  // Convert bare links.
  converted = converted.replace(/<([^<>|\s]+)>/g, (match, rawUrl: string) => {
    if (!isConvertibleSlackUrl(rawUrl)) {
      return match;
    }

    return decodeSlackEntity(rawUrl);
  });

  return converted;
}
