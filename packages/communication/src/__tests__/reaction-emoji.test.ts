import { describe, expect, it } from 'vitest';

import {
  formatReactionEmojiForDisplay,
  normalizeReactionEmoji,
  reactionEmojiMatches,
} from '../reaction-emoji';

describe('reaction emoji matching', () => {
  it('normalizes colon-wrapped aliases', () => {
    expect(normalizeReactionEmoji(':white_check_mark:')).toBe('✅');
    expect(reactionEmojiMatches(':white_check_mark:', '✅')).toBe(true);
  });

  it('strips long colon runs in linear time', () => {
    const colons = ':'.repeat(100_000);
    expect(normalizeReactionEmoji(`${colons}ship_it${colons}`)).toBe('ship_it');
  });

  it('matches provider aliases for the same reaction', () => {
    expect(reactionEmojiMatches('thumbsup', 'like')).toBe(true);
    expect(reactionEmojiMatches(':+1:', '👍')).toBe(true);
  });

  it('matches custom emoji names case-insensitively', () => {
    expect(reactionEmojiMatches(':Ship_It:', 'ship_it')).toBe(true);
    expect(reactionEmojiMatches(':ship_it:', 'eyes')).toBe(false);
  });

  it('formats known aliases as Unicode and custom names as Slack markup', () => {
    expect(formatReactionEmojiForDisplay('exploding_head')).toBe('🤯');
    expect(formatReactionEmojiForDisplay(':+1:')).toBe('👍');
    expect(formatReactionEmojiForDisplay('Ship_It')).toBe(':ship_it:');
  });
});
