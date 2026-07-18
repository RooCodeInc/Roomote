/**
 * Build the provisional or canonical title for a task-owned communication
 * thread. Providers may impose a smaller limit at the call site.
 *
 * Source text is cleaned for title use: attachment summary noise and leftover
 * provider mention markup (for example unresolved Discord snowflakes) are
 * dropped so the title stays human-readable.
 */
const ATTACHMENT_SUMMARY_LINE = /^(?:Image|Document|Attachment)\s*:\s+\S.*$/iu;

const INLINE_ATTACHMENT_SUMMARY =
  /\b(?:Image|Document|Attachment)\s*:\s+\S+/giu;

const PROVIDER_MARKUP = /<@!?&?\d+>|<#[\w-]+>|<a?:[\w~]+:\d+>|<\/?[^>\s]+>/gu;

function sanitizeCommunicationTaskThreadSource(description: string): string {
  const withoutAttachmentSummaries = description
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !ATTACHMENT_SUMMARY_LINE.test(line))
    .join(' ');

  return withoutAttachmentSummaries
    .replace(INLINE_ATTACHMENT_SUMMARY, ' ')
    .replace(PROVIDER_MARKUP, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

export function buildCommunicationTaskThreadName(
  description: string,
  maxLength = 96,
): string {
  const normalized =
    sanitizeCommunicationTaskThreadSource(description) || 'Roomote task';
  const characters = Array.from(normalized);

  return characters.length > maxLength
    ? `${characters.slice(0, maxLength - 1).join('')}…`
    : characters.join('');
}
