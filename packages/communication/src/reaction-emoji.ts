const REACTION_EMOJI_BY_NAME: Record<string, string> = {
  eyes: '👀',
  thumbsup: '👍',
  '+1': '👍',
  like: '👍',
  thumbsdown: '👎',
  '-1': '👎',
  heart: '❤️',
  white_check_mark: '✅',
  heavy_check_mark: '✔️',
  x: '❌',
  tada: '🎉',
  fire: '🔥',
  clap: '👏',
  laugh: '😆',
  joy: '😆',
  smile: '😄',
  surprised: '😮',
  open_mouth: '😮',
  scream: '😱',
  sad: '😢',
  cry: '😢',
  angry: '😠',
  rage: '😡',
  think: '🤔',
  thinking_face: '🤔',
  ok_hand: '👌',
  pray: '🙏',
  '100': '💯',
  wave: '👋',
  trophy: '🏆',
  handshake: '🤝',
  saluting_face: '🫡',
  rocket: '🚀',
  exploding_head: '🤯',
};

export function normalizeReactionEmoji(value: string): string {
  const trimmed = value.trim();
  let start = 0;
  let end = trimmed.length;
  while (start < end && trimmed.charCodeAt(start) === 58) start += 1;
  while (end > start && trimmed.charCodeAt(end - 1) === 58) end -= 1;
  const normalized = trimmed.slice(start, end).toLowerCase();
  return REACTION_EMOJI_BY_NAME[normalized] ?? normalized;
}

export function formatReactionEmojiForDisplay(value: string): string {
  const normalized = normalizeReactionEmoji(value);
  return /^[a-z0-9_+-]+$/u.test(normalized) ? `:${normalized}:` : normalized;
}

export function reactionEmojiMatches(
  configuredEmoji: string,
  receivedEmoji: string,
): boolean {
  return (
    Boolean(configuredEmoji.trim()) &&
    normalizeReactionEmoji(configuredEmoji) ===
      normalizeReactionEmoji(receivedEmoji)
  );
}
