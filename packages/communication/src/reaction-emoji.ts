import reactionEmojiData from './reaction-emoji-data.json';

const SKIN_TONE_SUFFIX = /^(.*)::skin-tone-([2-6])$/u;
const PROVIDER_REACTION_SHORTCODE_ALIASES: Readonly<Record<string, string>> = {
  // Microsoft Teams reports these provider-native names instead of Slack names.
  like: '+1',
  heart: 'heart',
  laugh: 'laughing',
  surprised: 'open_mouth',
  sad: 'cry',
  angry: 'angry',
};
const shortcodeToUnified: Readonly<Record<string, string>> =
  reactionEmojiData.shortcodes;
const shortcodeAliases: Readonly<Record<string, string>> =
  reactionEmojiData.aliases;
const skinTonesByShortcode: Readonly<
  Record<string, readonly (string | null)[]>
> = reactionEmojiData.skinTones;

function unifiedToEmoji(unified: string): string {
  return String.fromCodePoint(
    ...unified.split('-').map((codepoint) => Number.parseInt(codepoint, 16)),
  );
}

function resolveReactionEmoji(value: string): string | null {
  const skinToneMatch = SKIN_TONE_SUFFIX.exec(value);
  const shortcode = skinToneMatch?.[1] ?? value;
  const lookupShortcode =
    PROVIDER_REACTION_SHORTCODE_ALIASES[shortcode] ?? shortcode;
  const unified = shortcodeToUnified[lookupShortcode];
  if (!unified) return null;

  if (!skinToneMatch) return unifiedToEmoji(unified);
  const canonical = shortcodeAliases[lookupShortcode] ?? lookupShortcode;
  const variations = skinTonesByShortcode[canonical];
  const variation = variations?.[Number(skinToneMatch[2]) - 2];
  return variation ? unifiedToEmoji(variation) : null;
}

function stripWrappingColons(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) === 58) start += 1;
  while (end > start && value.charCodeAt(end - 1) === 58) end -= 1;
  return value.slice(start, end);
}

export function normalizeReactionEmoji(value: string): string {
  const trimmed = value.trim();
  const normalized = stripWrappingColons(trimmed).toLowerCase();
  return resolveReactionEmoji(normalized) ?? normalized;
}

export function formatReactionEmojiForDisplay(value: string): string {
  const trimmed = value.trim();
  const normalized = stripWrappingColons(trimmed).toLowerCase();
  const resolved = resolveReactionEmoji(normalized);
  if (resolved) return resolved;
  return /^[a-z0-9_+-]+(?:::[a-z0-9_+-]+)*$/u.test(normalized)
    ? `:${normalized}:`
    : trimmed;
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
