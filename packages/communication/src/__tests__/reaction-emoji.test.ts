import { describe, expect, it } from 'vitest';

import {
  normalizeReactionEmoji,
  reactionEmojiMatches,
} from '../reaction-emoji';

describe('reaction emoji matching', () => {
  it('normalizes colon-wrapped aliases', () => {
    expect(normalizeReactionEmoji(':white_check_mark:')).toBe('✅');
    expect(reactionEmojiMatches(':white_check_mark:', '✅')).toBe(true);
  });

  it('matches provider aliases for the same reaction', () => {
    expect(reactionEmojiMatches('thumbsup', 'like')).toBe(true);
    expect(reactionEmojiMatches(':+1:', '👍')).toBe(true);
  });

  it('matches custom emoji names case-insensitively', () => {
    expect(reactionEmojiMatches(':Ship_It:', 'ship_it')).toBe(true);
    expect(reactionEmojiMatches(':ship_it:', 'eyes')).toBe(false);
  });
});
