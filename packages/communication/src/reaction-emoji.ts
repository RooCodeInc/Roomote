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
};

export function normalizeReactionEmoji(value: string): string {
  const normalized = value
    .trim()
    .replace(/^:+|:+$/gu, '')
    .toLowerCase();
  return REACTION_EMOJI_BY_NAME[normalized] ?? normalized;
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
