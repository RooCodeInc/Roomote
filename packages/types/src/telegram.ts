/**
 * Builds a Telegram message permalink (`https://t.me/...`) for the originating
 * chat when enough metadata is available.
 *
 * Telegram supports several deep-link shapes:
 *  - public channels/groups:  `https://t.me/<username>/<messageId>`
 *  - private supergroups and  `https://t.me/c/<internalId>/<threadId>/<messageId>`
 *    channels (negative chat id):
 *  - personal/bot DMs:        `https://t.me/<botUsername>` (opens the chat
 *    itself; Telegram does not expose public deep links to a specific
 *    message in a private chat).
 *
 * Roomote only persists the numeric chat id (and optional forum-topic thread
 * id), not the public channel username, so this builder targets the `c/` form
 * for supergroup/channel chat ids. Personal chats use positive ids that
 * Telegram cannot deep-link by id alone, so they fall back to the bot DM link
 * (`https://t.me/<botUsername>`) when a bot username is supplied, opening the
 * user's conversation with the Roomote bot.
 *
 * For forum topics (supergroups with topics enabled), including the thread id
 * keeps the link scoped to the correct topic:
 * `https://t.me/c/<internalId>/<threadId>/<messageId>`.
 */
export function buildTelegramMessagePermalink(params: {
  chatId?: string | null;
  messageId?: string | null;
  threadId?: string | null;
  botUsername?: string | null;
}): string | null {
  const chatId = params.chatId?.trim();
  const messageId = params.messageId?.trim();

  if (!chatId) {
    return null;
  }

  // Supergroup and private-channel chat ids look like `-100<internalId>`.
  // Strip the `-100` prefix to recover the internal id used in `t.me/c/...`.
  const supergroupMatch = chatId.match(/^-100(\d+)$/);

  if (supergroupMatch) {
    if (!messageId) {
      return null;
    }

    const internalId = supergroupMatch[1]!;
    const threadId = params.threadId?.trim();

    if (threadId) {
      return `https://t.me/c/${internalId}/${threadId}/${messageId}`;
    }

    return `https://t.me/c/${internalId}/${messageId}`;
  }

  // Personal chats / bot DMs use positive ids that Telegram cannot deep-link
  // to a specific message by id. Fall back to the bot's DM link so reviewers
  // can still return to the conversation with the Roomote bot.
  const botUsername = params.botUsername?.trim().replace(/^@/, '');

  if (botUsername) {
    return `https://t.me/${botUsername}`;
  }

  return null;
}
