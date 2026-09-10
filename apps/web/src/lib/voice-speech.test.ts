import { describe, expect, it } from 'vitest';

import { chunkSpeakableText, toSpeakableText } from './voice-speech';

describe('toSpeakableText', () => {
  it('summarizes fenced code blocks instead of reading them', () => {
    const result = toSpeakableText(
      'Here is the fix:\n```ts\nconst x = 1;\n```\nDeployed.',
    );

    expect(result).toContain('Code block omitted.');
    expect(result).not.toContain('const x = 1');
  });

  it('keeps link labels and drops URLs', () => {
    expect(toSpeakableText('See [the docs](https://example.com/a?b=c).')).toBe(
      'See the docs.',
    );
    expect(toSpeakableText('Raw: https://example.com/long/path')).toBe(
      'Raw: a link',
    );
  });

  it('strips markdown structure markers', () => {
    const result = toSpeakableText(
      '# Title\n\n- **bold** item\n1. `inline` step\n> quoted',
    );

    expect(result).toBe('Title\nbold item\ninline step\nquoted');
  });

  it('drops image syntax without leaving punctuation behind', () => {
    expect(toSpeakableText('Before ![diagram](https://x/y.png) after')).toBe(
      'Before diagram after',
    );
  });
});

describe('chunkSpeakableText', () => {
  it('returns short text as a single chunk', () => {
    expect(chunkSpeakableText('Hello there.', 100)).toEqual(['Hello there.']);
  });

  it('returns nothing for blank input', () => {
    expect(chunkSpeakableText('   ', 100)).toEqual([]);
  });

  it('splits on sentence boundaries under the cap', () => {
    const chunks = chunkSpeakableText(
      'First sentence here. Second sentence follows. Third one ends it.',
      30,
    );

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(30);
    }
    expect(chunks.join(' ')).toBe(
      'First sentence here. Second sentence follows. Third one ends it.',
    );
  });

  it('hard-splits a single unbreakable run at the cap', () => {
    const chunks = chunkSpeakableText('a'.repeat(25), 10);

    expect(chunks).toEqual(['a'.repeat(10), 'a'.repeat(10), 'a'.repeat(5)]);
  });
});
