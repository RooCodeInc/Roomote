const SLACK_QUOTE_MAX_LENGTH = 100;
const MARKDOWN_QUOTE_MAX_LENGTH = 280;

type FastAgentReplyQuoteSource = {
  senderDisplayName: string | null;
  text: string;
};

export function createPendingFastAgentReplyQuote(
  source: FastAgentReplyQuoteSource | null,
): {
  peek: (
    format: (source: FastAgentReplyQuoteSource) => string | null,
  ) => string | null;
  markDelivered: () => void;
} {
  let pending = source;
  return {
    peek: (format) => (pending ? format(pending) : null),
    markDelivered: () => {
      pending = null;
    },
  };
}

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

function escapeMarkdownText(text: string): string {
  return text
    .replaceAll('\\', '\\\\')
    .replaceAll('*', '\\*')
    .replaceAll('_', '\\_')
    .replaceAll('~', '\\~')
    .replaceAll('`', '\\`')
    .replaceAll('[', '\\[')
    .replaceAll(']', '\\]')
    .replaceAll('>', '\\>');
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
  const username = escapeMarkdownText(
    normalizeQuoteText(params.senderDisplayName ?? 'Someone'),
  );
  const text = escapeMarkdownText(
    truncateQuoteText(
      normalizeQuoteText(params.text),
      MARKDOWN_QUOTE_MAX_LENGTH,
    ),
  );
  return username && text ? `> **${username}:** ${text}` : null;
}
