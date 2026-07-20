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

const DISCORD_LINK_HOSTS = new Set([
  'discord.com',
  'discordapp.com',
  'canary.discord.com',
  'ptb.discord.com',
  'canary.discordapp.com',
  'ptb.discordapp.com',
]);

const DISCORD_SNOWFLAKE_OR_ME = /^(?:\d+|@me)$/;
const DISCORD_SNOWFLAKE = /^\d+$/;

/**
 * Parses a Discord message or channel permalink into guild/channel/message ids.
 * Accepts `discord.com`, `discordapp.com`, canary, and ptb hosts.
 *
 * Uses URL + segment checks instead of a single end-anchored regex so path
 * parsing stays linear-time on adversarial inputs.
 */
export function parseDiscordMessagePermalink(raw: string): {
  guildId: string | null;
  channelId: string;
  messageId: string | null;
} | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return null;
  }

  const host = url.hostname.toLowerCase();
  if (!DISCORD_LINK_HOSTS.has(host)) {
    return null;
  }

  // Expected path: /channels/{guild|@me}/{channel}[/{message}]
  const segments = url.pathname
    .split('/')
    .filter((segment) => segment.length > 0);
  if (segments.length < 3 || segments.length > 4) {
    return null;
  }
  if (segments[0] !== 'channels') {
    return null;
  }

  const guildRaw = segments[1] ?? '';
  const channelId = segments[2] ?? '';
  const messageRaw = segments[3] ?? '';

  if (!DISCORD_SNOWFLAKE_OR_ME.test(guildRaw)) {
    return null;
  }
  if (!DISCORD_SNOWFLAKE.test(channelId)) {
    return null;
  }
  if (messageRaw && !DISCORD_SNOWFLAKE.test(messageRaw)) {
    return null;
  }

  return {
    guildId: guildRaw === '@me' ? null : guildRaw,
    channelId,
    messageId: messageRaw || null,
  };
}
