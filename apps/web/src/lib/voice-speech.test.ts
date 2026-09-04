import { describe, expect, it } from 'vitest';

import {
  chunkSpeakableText,
  findSpeakableBoundary,
  toSpeakableText,
} from './voice-speech';

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

describe('findSpeakableBoundary', () => {
  it('returns the end of the last complete sentence', () => {
    const text = 'First sentence. Second sentence! Third is still going';
    expect(findSpeakableBoundary(text, 0)).toBe(
      'First sentence. Second sentence!'.length,
    );
  });

  it('treats a newline as a boundary', () => {
    const text = 'A heading\nStill typing';
    expect(findSpeakableBoundary(text, 0)).toBe('A heading\n'.length);
  });

  it('returns the start when no sentence has finished', () => {
    expect(findSpeakableBoundary('Still typing', 0)).toBe(0);
    expect(findSpeakableBoundary('Version 3.5 is out', 0)).toBe(0);
  });

  it('only advances past the given start', () => {
    const text = 'Done. More coming';
    const first = findSpeakableBoundary(text, 0);
    expect(first).toBe('Done.'.length);
    expect(findSpeakableBoundary(text, first)).toBe(first);
  });

  it('holds back text inside an unclosed code fence', () => {
    const open = 'Here is code. ```ts\nconst a = 1. Or so;';
    expect(findSpeakableBoundary(open, 0)).toBe('Here is code.'.length);
    const closed = `${open}\n\`\`\`\nAll done. `;
    expect(findSpeakableBoundary(closed, 0)).toBe(closed.length - 1);
  });
});
