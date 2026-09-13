import { describe, expect, it } from 'vitest';

import {
  TELEGRAM_MAX_MESSAGE_LENGTH,
  TELEGRAM_MAX_RICH_MESSAGE_LENGTH,
  chunkTelegramMarkdown,
  chunkTelegramText,
  planTelegramRichMessages,
} from '../telegram-format';

describe('chunkTelegramText', () => {
  it('keeps text at the exact limit in one chunk', () => {
    const text = 'x'.repeat(TELEGRAM_MAX_MESSAGE_LENGTH);

    expect(chunkTelegramText(text)).toEqual([text]);
  });

  it('splits text one character over the limit without losing content', () => {
    const text = 'x'.repeat(TELEGRAM_MAX_MESSAGE_LENGTH + 1);
    const chunks = chunkTelegramText(text);

    expect(chunks).toHaveLength(2);
    expect(chunks.join('')).toBe(text);
  });

  it('preserves every character while preferring paragraph boundaries', () => {
    const text = `${'a'.repeat(3_000)}\n\n${'b'.repeat(3_000)}`;
    const chunks = chunkTelegramText(text);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(`${'a'.repeat(3_000)}\n\n`);
    expect(chunks.join('')).toBe(text);
  });

  it('hard-splits long unbroken text without breaking Unicode', () => {
    const text = '🙂'.repeat(5_000);
    const chunks = chunkTelegramText(text);

    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.join('')).toBe(text);
    expect(chunks.every((chunk) => chunk.length <= 4_096)).toBe(true);
    expect(chunks.every((chunk) => !chunk.includes('\uFFFD'))).toBe(true);
    expect(
      chunks.every(
        (chunk) =>
          !/^[\uDC00-\uDFFF]/.test(chunk) && !/[\uD800-\uDBFF]$/.test(chunk),
      ),
    ).toBe(true);
  });

  it('always advances at the minimum length around a surrogate pair', () => {
    expect(chunkTelegramText('a🙂', 2)).toEqual(['a', '🙂']);
    expect(chunkTelegramText('🙂a', 2)).toEqual(['🙂', 'a']);
    expect(() => chunkTelegramText('🙂', 1)).toThrow(
      'Telegram chunk length must be an integer of at least 2.',
    );
  });
});

describe('chunkTelegramMarkdown', () => {
  it('returns short text as a single chunk', () => {
    expect(chunkTelegramMarkdown('hello', 100)).toEqual(['hello']);
  });

  it('splits long text at line boundaries', () => {
    const lines = Array.from(
      { length: 10 },
      (_, i) => `line ${i} ${'x'.repeat(30)}`,
    );
    const chunks = chunkTelegramMarkdown(lines.join('\n'), 100);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('')).toBe(lines.join('\n'));
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(100);
    }
  });

  it('closes and reopens code fences across chunk boundaries', () => {
    const codeLines = Array.from(
      { length: 8 },
      (_, i) => `code line ${i} ${'y'.repeat(20)}`,
    );
    const markdown = ['```ts', ...codeLines, '```'].join('\n');
    const chunks = chunkTelegramMarkdown(markdown, 120);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      const fenceCount = chunk
        .split('\n')
        .filter((line) => line.startsWith('```')).length;
      expect(fenceCount % 2).toBe(0);
    }
  });

  it.each([
    ['tilde', '~~~~ts', '~~~~'],
    ['long backtick', '````ts', '````'],
  ])('closes and reopens oversized %s fences', (_name, opening, closing) => {
    const codeLines = Array.from(
      { length: 8 },
      (_, index) => `code line ${index} ${'y'.repeat(20)}`,
    );
    const chunks = chunkTelegramMarkdown(
      [opening, ...codeLines, closing].join('\n'),
      120,
    );

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.startsWith(opening)).toBe(true);
      expect(chunk.endsWith(closing)).toBe(true);
      expect(chunk.length).toBeLessThanOrEqual(120);
    }
  });

  it('reserves the actual decoration overhead for very long fence markers', () => {
    const marker = '`'.repeat(6_000);
    const markdown = [
      `${marker}ts`,
      'x'.repeat(TELEGRAM_MAX_RICH_MESSAGE_LENGTH),
      marker,
    ].join('\n');
    const chunks = chunkTelegramMarkdown(
      markdown,
      TELEGRAM_MAX_RICH_MESSAGE_LENGTH,
    );

    expect(chunks.length).toBeGreaterThan(1);
    expect(
      chunks.every((chunk) => chunk.length <= TELEGRAM_MAX_RICH_MESSAGE_LENGTH),
    ).toBe(true);
    expect(chunks[0]!.endsWith(marker)).toBe(true);
    expect(chunks[1]!.startsWith(`${marker}ts\n`)).toBe(true);
  });

  it('hard-splits single lines longer than the limit', () => {
    const chunks = chunkTelegramMarkdown('z'.repeat(500), 100);

    expect(chunks.join('')).toBe('z'.repeat(500));
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(100);
    }
  });

  it('preserves a trailing newline without emitting an empty chunk', () => {
    const line = 'x'.repeat(3_499);
    const markdown = `${line}\n${line}\n`;
    const chunks = chunkTelegramMarkdown(markdown, 3_500);

    expect(chunks.join('')).toBe(markdown);
    expect(chunks.every((chunk) => chunk.length > 0)).toBe(true);
    expect(chunks.every((chunk) => chunk.length <= 3_500)).toBe(true);
  });
});

describe('planTelegramRichMessages', () => {
  it('keeps rendered messages above 4096 together below the rich limit', () => {
    const text = 'x'.repeat(10_000);
    expect(planTelegramRichMessages({ text })).toEqual([
      { text, richMessage: { markdown: `<p>${text}</p>` } },
    ]);
  });

  it('passes broad Markdown features through to Telegram unchanged', () => {
    const text = [
      '# Heading',
      '',
      '- [x] **Nested _formatting_**',
      '',
      '| Feature | Status |',
      '| --- | --- |',
      '| Tables | Supported |',
      '',
      '> Quotation',
      '',
      'Formula: $x^2$',
      '',
      'Footnote[^1]',
      '',
      '[^1]: Native Rich Markdown',
    ].join('\n');

    expect(planTelegramRichMessages({ text, textFormat: 'markdown' })).toEqual([
      { text, richMessage: { markdown: text } },
    ]);
  });

  it('splits above the rich limit and reserves footer overhead', () => {
    const text = 'paragraph '.repeat(8_000);
    const chunks = planTelegramRichMessages({
      text,
      footerText: '[Open](https://roomote.test)',
      textFormat: 'markdown',
    });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((chunk) => chunk.text).join('')).toBe(text);
    expect(
      chunks.every(
        (chunk) =>
          chunk.richMessage.markdown!.length <=
          TELEGRAM_MAX_RICH_MESSAGE_LENGTH,
      ),
    ).toBe(true);
    expect(
      chunks
        .slice(0, -1)
        .every((chunk) => !chunk.richMessage.markdown!.includes('<footer>')),
    ).toBe(true);
    expect(chunks.at(-1)?.richMessage.markdown).toContain(
      '<footer><a href="https://roomote.test">Open</a></footer>',
    );
  });

  it('counts the complete Markdown and HTML footer source at the exact limit', () => {
    const footerText = '[Open](https://roomote.test/?a=1&b=2)';
    const footerSuffix =
      '\n\n<footer><a href="https://roomote.test/?a=1&amp;b=2">Open</a></footer>';
    const text = 'x'.repeat(
      TELEGRAM_MAX_RICH_MESSAGE_LENGTH - footerSuffix.length,
    );

    const chunks = planTelegramRichMessages({
      text,
      footerText,
      textFormat: 'markdown',
    });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual({
      text,
      richMessage: { markdown: `${text}${footerSuffix}` },
    });
    expect(chunks[0]!.richMessage.markdown).toHaveLength(
      TELEGRAM_MAX_RICH_MESSAGE_LENGTH,
    );
  });

  it('splits Markdown one character over the body budget', () => {
    const footerText = '[Open](https://roomote.test)';
    const footerSuffix =
      '\n\n<footer><a href="https://roomote.test">Open</a></footer>';
    const text = 'x'.repeat(
      TELEGRAM_MAX_RICH_MESSAGE_LENGTH - footerSuffix.length + 1,
    );

    const chunks = planTelegramRichMessages({
      text,
      footerText,
      textFormat: 'markdown',
    });

    expect(chunks).toHaveLength(2);
    expect(chunks.map((chunk) => chunk.text).join('')).toBe(text);
    expect(
      chunks.every(
        (chunk) =>
          chunk.richMessage.markdown!.length <=
          TELEGRAM_MAX_RICH_MESSAGE_LENGTH,
      ),
    ).toBe(true);
    expect(chunks[0]!.richMessage.markdown).not.toContain('<footer>');
    expect(chunks[1]!.richMessage.markdown).toContain('<footer>');
  });

  it('closes an unterminated code fence before the native footer', () => {
    const text = '```ts\n```not a closing fence\nconst complete = true;';

    expect(
      planTelegramRichMessages({
        text,
        footerText: '[Open](https://roomote.test)',
        textFormat: 'markdown',
      }),
    ).toEqual([
      {
        text,
        richMessage: {
          markdown: [
            text,
            '```',
            '',
            '<footer><a href="https://roomote.test">Open</a></footer>',
          ].join('\n'),
        },
      },
    ]);
  });

  it('closes an unterminated tilde fence with the matching marker', () => {
    const text = '~~~~md\n# still code';
    const [chunk] = planTelegramRichMessages({
      text,
      footerText: 'Open',
      textFormat: 'markdown',
    });

    expect(chunk!.text).toBe(text);
    expect(chunk!.richMessage.markdown).toBe(
      `${text}\n~~~~\n\n<footer>Open</footer>`,
    );
  });

  it('includes a synthetic fence closure in the footer length budget', () => {
    const footerSuffix =
      '\n\n<footer><a href="https://roomote.test">Open</a></footer>';
    const text = `\`\`\`\n${'x'.repeat(
      TELEGRAM_MAX_RICH_MESSAGE_LENGTH - footerSuffix.length - 4,
    )}`;
    const chunks = planTelegramRichMessages({
      text,
      footerText: '[Open](https://roomote.test)',
      textFormat: 'markdown',
    });

    expect(chunks.length).toBeGreaterThan(1);
    expect(
      chunks.every(
        (chunk) =>
          chunk.richMessage.markdown!.length <=
          TELEGRAM_MAX_RICH_MESSAGE_LENGTH,
      ),
    ).toBe(true);
    expect(chunks.at(-1)!.richMessage.markdown).toMatch(
      /```\n\n<footer>.*<\/footer>$/,
    );
  });

  it('uses the full body budget for large valid fence markers', () => {
    const marker = '`'.repeat(14_000);
    const text = [`${marker}ts`, 'x'.repeat(5_000), marker].join('\n');
    const chunks = planTelegramRichMessages({
      text,
      footerText: '[Open](https://roomote.test)',
      textFormat: 'markdown',
    });

    expect(chunks.length).toBeGreaterThan(1);
    expect(
      chunks.every(
        (chunk) =>
          chunk.richMessage.markdown!.length <=
          TELEGRAM_MAX_RICH_MESSAGE_LENGTH,
      ),
    ).toBe(true);
    expect(chunks.at(-1)!.richMessage.markdown).toContain('<footer>');
  });

  it('accounts for escaping expansion when splitting plain text', () => {
    const text = '&<>'.repeat(20_000);
    const chunks = planTelegramRichMessages({ text });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((chunk) => chunk.text).join('')).toBe(text);
    expect(
      chunks.every(
        (chunk) =>
          chunk.richMessage.markdown.length <= TELEGRAM_MAX_RICH_MESSAGE_LENGTH,
      ),
    ).toBe(true);
    expect(
      chunks.every(
        (chunk) =>
          chunk.richMessage.markdown.startsWith('<p>') &&
          chunk.richMessage.markdown.endsWith('</p>'),
      ),
    ).toBe(true);
  });

  it('preserves literal plain text inside embedded Rich HTML', () => {
    const text = '**literal** <b>not bold</b>\n\n- not a list';

    expect(planTelegramRichMessages({ text })).toEqual([
      {
        text,
        richMessage: {
          markdown:
            '<p>**literal** &lt;b&gt;not bold&lt;/b&gt;<br><br>- not a list</p>',
        },
      },
    ]);
  });

  it('preserves plain-text newlines with embedded Rich HTML breaks', () => {
    expect(planTelegramRichMessages({ text: 'first\n\n- second' })).toEqual([
      {
        text: 'first\n\n- second',
        richMessage: { markdown: '<p>first<br><br>- second</p>' },
      },
    ]);
  });

  it('keeps explicit provider HTML authoritative for Markdown source text', () => {
    expect(
      planTelegramRichMessages({
        text: '**Working**',
        htmlText: '<tg-thinking>Working</tg-thinking>',
        textFormat: 'markdown',
      }),
    ).toEqual([
      {
        text: '**Working**',
        richMessage: { markdown: '<tg-thinking>Working</tg-thinking>' },
      },
    ]);
  });
});
