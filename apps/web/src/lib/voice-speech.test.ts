import { describe, expect, it } from 'vitest';

import {
  chunkSpeakableText,
  splitSpeakableSentences,
  stripVoiceAnnotations,
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

describe('splitSpeakableSentences', () => {
  it('splits on sentence punctuation and line breaks, keeping the tail', () => {
    expect(
      splitSpeakableSentences(
        'First sentence. Second one!\nThird on its own line\nFourth? Trailing fragment',
      ),
    ).toEqual([
      'First sentence.',
      'Second one!',
      'Third on its own line',
      'Fourth?',
      'Trailing fragment',
    ]);
  });

  it('does not split a version number or a trailing period', () => {
    expect(splitSpeakableSentences('Bumped to 1.2.3 today.')).toEqual([
      'Bumped to 1.2.3 today.',
    ]);
  });

  it('returns nothing for empty text', () => {
    expect(splitSpeakableSentences('   ')).toEqual([]);
  });
});

describe('stripVoiceAnnotations', () => {
  it('drops bracketed sound annotations and tidies the spacing', () => {
    expect(
      stripVoiceAnnotations('[chuckle] Can you can you sing your updates'),
    ).toBe('Can you can you sing your updates');
    expect(stripVoiceAnnotations('[tongue click] Aww GPT. No [sigh]')).toBe(
      'Aww GPT. No',
    );
    expect(stripVoiceAnnotations('Okay [laughs] sure')).toBe('Okay sure');
  });

  it('keeps bracketed text that is not an annotation', () => {
    expect(stripVoiceAnnotations('Look at [PR #42] and [v1.2.3]')).toBe(
      'Look at [PR #42] and [v1.2.3]',
    );
  });

  it('returns nothing for annotation-only speech', () => {
    expect(stripVoiceAnnotations('[cough]')).toBe('');
  });
});
