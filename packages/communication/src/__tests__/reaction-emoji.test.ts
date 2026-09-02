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

  it.each([
    ['exploding_head', '🤯'],
    ['shocked_face_with_exploding_head', '🤯'],
    [':+1:', '👍'],
    ['thumbsup', '👍'],
    ['flag-gb', '🇬🇧'],
    ['female-technologist', '👩‍💻'],
    ['thumbsup::skin-tone-6', '👍🏿'],
    [':thumbsup::skin-tone-6:', '👍🏿'],
    ['female-technologist::skin-tone-3', '👩🏼‍💻'],
  ])('formats standard shortcode %s as %s', (shortcode, emoji) => {
    expect(formatReactionEmojiForDisplay(shortcode)).toBe(emoji);
  });

  it('formats unknown workspace emoji as Slack markup', () => {
    expect(formatReactionEmojiForDisplay('Ship_It')).toBe(':ship_it:');
    expect(formatReactionEmojiForDisplay('ship_it::skin-tone-3')).toBe(
      ':ship_it::skin-tone-3:',
    );
  });
});
