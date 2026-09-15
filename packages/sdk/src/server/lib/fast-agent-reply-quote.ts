const SLACK_QUOTE_MAX_LENGTH = 100;
const MARKDOWN_QUOTE_MAX_LENGTH = 280;

function normalizeQuoteText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function truncateQuoteText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength).trimEnd()}...`;
}

function escapeSlackMrkdwnText(text: string): string {
  return text
    .replaceAll('\\', '\\\\')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('*', '\\*')
    .replaceAll('_', '\\_')
    .replaceAll('~', '\\~')
    .replaceAll('`', '\\`');
}

export function buildSlackReplyQuote(params: {
  senderDisplayName: string | null;
  text: string;
}): string | null {
  const username = escapeSlackMrkdwnText(
    normalizeQuoteText(params.senderDisplayName ?? 'Someone'),
  );
  const text = escapeSlackMrkdwnText(
    truncateQuoteText(normalizeQuoteText(params.text), SLACK_QUOTE_MAX_LENGTH),
  );
  return username && text ? `>*${username}:* ${text}` : null;
}

export function buildMarkdownReplyQuote(params: {
  senderDisplayName: string | null;
  text: string;
}): string | null {
  const username = normalizeQuoteText(params.senderDisplayName ?? 'Someone');
  const text = truncateQuoteText(
    normalizeQuoteText(params.text),
    MARKDOWN_QUOTE_MAX_LENGTH,
  );
  return username && text ? `> **${username}:** ${text}` : null;
}
