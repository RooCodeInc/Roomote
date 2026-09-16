import type { SlackEvent, SlackThreadMessage } from '@roomote/slack';

type SlackMentionTextSource =
  | Pick<SlackEvent, 'text' | 'authoredText'>
  | Pick<SlackThreadMessage, 'text' | 'authoredText'>;

const SLACK_ROUTING_DIRECTIVE_WINDOW_MAX_CHARS = 500;

function getSlackAuthoredText(message: SlackMentionTextSource): string {
  if (typeof message.authoredText === 'string') {
    return message.authoredText;
  }

  if (typeof message.text === 'string') {
    return message.text;
  }

  return '';
}

function isSlackRoutingQuotedOrCodeLine(line: string): boolean {
  // We intentionally bail on the first fence-like line instead of tracking
  // open/close fence state across the rest of the message.
  return (
    line.startsWith('>') || line.startsWith('```') || line.startsWith('~~~')
  );
}

export function getSlackMentionDirectiveText(
  message: SlackMentionTextSource,
): string {
  const lines = getSlackAuthoredText(message).split(/\r?\n/u);
  const candidateLines: string[] = [];
  let remainingChars = SLACK_ROUTING_DIRECTIVE_WINDOW_MAX_CHARS;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (line.length === 0) {
      continue;
    }

    if (isSlackRoutingQuotedOrCodeLine(line)) {
      break;
    }

    candidateLines.push(line.slice(0, remainingChars));
    remainingChars -= line.length;

    if (remainingChars <= 0) {
      break;
    }
  }

  return candidateLines.join(' ');
}

export function getMentionedSlackUserIds(
  message: SlackMentionTextSource,
): string[] {
  return Array.from(
    getSlackMentionDirectiveText(message).matchAll(/<@([^>|]+)(?:\|[^>]+)?>/g),
  )
    .map((match) => match[1])
    .filter((userId): userId is string => Boolean(userId));
}

export function mentionsSlackUserOtherThanBot(
  message: SlackMentionTextSource,
  botUserId: string | null | undefined,
): boolean {
  return getMentionedSlackUserIds(message).some(
    (userId) => userId !== botUserId,
  );
}

export function mentionsSlackBot(
  message: SlackMentionTextSource,
  botUserId: string | null | undefined,
): boolean {
  return (
    Boolean(botUserId) &&
    getMentionedSlackUserIds(message).some((userId) => userId === botUserId)
  );
}

export function mentionsSlackUserOtherThanBotOrUser(
  message: SlackMentionTextSource,
  botUserId: string | null | undefined,
  slackUserId: string | null | undefined,
): boolean {
  return getMentionedSlackUserIds(message).some(
    (userId) => userId !== botUserId && userId !== slackUserId,
  );
}

export function mentionsSlackUserOtherThanBotWithoutMentioningBot(
  message: SlackMentionTextSource,
  botUserId: string | null | undefined,
): boolean {
  const mentionedUserIds = getMentionedSlackUserIds(message);
  return (
    mentionedUserIds.length > 0 &&
    !mentionedUserIds.some((userId) => userId === botUserId)
  );
}
