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
