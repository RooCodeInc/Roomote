/**
 * Builds a Microsoft Teams deep link to a specific message in a channel or
 * personal chat.
 *
 * The Teams deep-link format for a single message is:
 * `https://teams.microsoft.com/l/message/<conversationId>/<messageId>?tenantId=<tenantId>`
 *
 * `conversationId` is the Bot Framework / Graph conversation id. For channels
 * and channel-style conversations this looks like `19:...@thread.v2` and
 * `l/message/...` opens the specific message. For personal (1:1) chats the
 * conversation id looks like `a:...`; the `l/message/...` deep link does not
 * open those reliably, so personal chats fall back to the bot's personal-app
 * deep link `https://teams.microsoft.com/l/app/<botAppId>?tenantId=<tenantId>`
 * when a bot app id is provided, which opens the user's 1:1 conversation with
 * the Roomote bot.
 *
 * `tenantId` is optional but improves routing into the correct tenant.
 */
export function buildTeamsMessagePermalink(params: {
  conversationId?: string | null;
  messageId?: string | null;
  tenantId?: string | null;
  botAppId?: string | null;
}): string | null {
  const conversationId = params.conversationId?.trim();
  const tenantId = params.tenantId?.trim();
  const tenantQuery = tenantId
    ? `?tenantId=${encodeURIComponent(tenantId)}`
    : '';

  // Personal (1:1) Bot Framework conversations use an `a:` prefix. The
  // `l/message/...` deep link does not open those reliably, so fall back to
  // the bot's personal-app deep link, which opens the user's DM with the bot.
  if (conversationId && conversationId.startsWith('a:')) {
    const botAppId = params.botAppId?.trim();
    if (!botAppId) {
      return null;
    }
    return `https://teams.microsoft.com/l/app/${encodeURIComponent(botAppId)}${tenantQuery}`;
  }

  const messageId = params.messageId?.trim();

  if (!conversationId || !messageId) {
    return null;
  }

  const baseUrl = `https://teams.microsoft.com/l/message/${encodeURIComponent(conversationId)}/${encodeURIComponent(messageId)}`;

  return tenantId
    ? `${baseUrl}?tenantId=${encodeURIComponent(tenantId)}`
    : baseUrl;
}
