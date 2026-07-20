export function buildDiscordMessagePermalink(input: {
  guildId?: string | null;
  channelId?: string | null;
  messageId?: string | null;
}): string | null {
  const channelId = input.channelId?.trim();
  if (!channelId) return null;
  const guildId = input.guildId?.trim() || '@me';
  const messageId = input.messageId?.trim();
  const base = `https://discord.com/channels/${guildId}/${channelId}`;
  return messageId ? `${base}/${messageId}` : base;
}

const DISCORD_MESSAGE_LINK_REGEX =
  /^https?:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/channels\/(\d+|@me)\/(\d+)(?:\/(\d+))?\/?(?:\?.*)?(?:#.*)?$/i;

/**
 * Parses a Discord message or channel permalink into guild/channel/message ids.
 * Accepts `discord.com`, `discordapp.com`, canary, and ptb hosts.
 */
export function parseDiscordMessagePermalink(raw: string): {
  guildId: string | null;
  channelId: string;
  messageId: string | null;
} | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let pathname: string;
  try {
    const url = new URL(trimmed);
    pathname = `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    pathname = trimmed;
  }

  const match = pathname.match(DISCORD_MESSAGE_LINK_REGEX);
  if (!match) return null;

  const guildRaw = match[1] ?? '';
  const channelId = match[2]?.trim() ?? '';
  const messageId = match[3]?.trim() || null;
  if (!channelId) return null;

  return {
    guildId: guildRaw === '@me' ? null : guildRaw,
    channelId,
    messageId,
  };
}
