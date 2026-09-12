import { describe, expect, it } from 'vitest';

import {
  TELEGRAM_MAX_MESSAGE_LENGTH,
  TELEGRAM_MAX_RICH_MESSAGE_LENGTH,
  chunkTelegramMarkdown,
  chunkTelegramMarkdownAsHtml,
  chunkTelegramText,
  markdownToTelegramHtml,
  planTelegramRichMessages,
} from '../telegram-format';

describe('markdownToTelegramHtml', () => {
  it('converts bold, italic, strikethrough, and inline code', () => {
    expect(
      markdownToTelegramHtml('**bold** and *italic* and ~~gone~~ and `code`'),
    ).toBe(
      '<b>bold</b> and <i>italic</i> and <s>gone</s> and <code>code</code>',
    );
  });

  it('converts markdown links to anchors', () => {
    expect(
      markdownToTelegramHtml('see [the task](https://example.test/t/1)'),
    ).toBe('see <a href="https://example.test/t/1">the task</a>');
  });

  it('escapes HTML special characters', () => {
    expect(markdownToTelegramHtml('a < b && c > d')).toBe(
      'a &lt; b &amp;&amp; c &gt; d',
    );
  });

  it('renders headings as bold lines', () => {
    expect(markdownToTelegramHtml('## Summary\ndone')).toBe(
      '<h2>Summary</h2><p>done</p>',
    );
  });

  it('renders paragraphs and lists as rich-message blocks', () => {
    expect(
      markdownToTelegramHtml(
        '**Highlights**\n\n- **Voice.** Talk to Roomote.\n- **Skills.** Reuse [team skills](https://example.test/skills).\n\nNext `step`.',
      ),
    ).toBe(
      '<p><b>Highlights</b></p><ul><li><b>Voice.</b> Talk to Roomote.</li><li><b>Skills.</b> Reuse <a href="https://example.test/skills">team skills</a>.</li></ul><p>Next <code>step</code>.</p>',
    );
  });

  it('preserves soft line breaks within a paragraph', () => {
    expect(markdownToTelegramHtml('first line\nsecond line')).toBe(
      '<p>first line<br>second line</p>',
    );
  });

  it('renders ordered markdown lists', () => {
    expect(markdownToTelegramHtml('1. First\n2. Second')).toBe(
      '<ol><li>First</li><li>Second</li></ol>',
    );
  });

  it('converts fenced code blocks with language hints', () => {
    expect(markdownToTelegramHtml('```ts\nconst a = 1;\n```')).toBe(
      '<pre><code class="language-ts">const a = 1;</code></pre>',
    );
  });

  it('converts fenced code blocks without language hints', () => {
    expect(markdownToTelegramHtml('```\nplain <text>\n```')).toBe(
      '<pre>plain &lt;text&gt;</pre>',
    );
  });

  it('leaves emphasis markers inside code spans untouched', () => {
    expect(markdownToTelegramHtml('`**not bold**` but **bold**')).toBe(
      '<code>**not bold**</code> but <b>bold</b>',
    );
  });

  it('does not italicize snake_case identifiers', () => {
    expect(
      markdownToTelegramHtml('set R_TELEGRAM_BOT_TOKEN and my_var_name'),
    ).toBe('set R_TELEGRAM_BOT_TOKEN and my_var_name');
  });

  it('italicizes whole lines wrapped in underscores (footer style)', () => {
    expect(
      markdownToTelegramHtml('_Reply or use the [web app](https://a.test)._'),
    ).toBe('<i>Reply or use the <a href="https://a.test">web app</a>.</i>');
  });
});

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

describe('chunkTelegramMarkdownAsHtml', () => {
  it('returns a single converted chunk for short markdown', () => {
    expect(chunkTelegramMarkdownAsHtml('**hi**')).toEqual([
      { markdown: '**hi**', html: '<b>hi</b>' },
    ]);
  });

  it('preserves exact-target markdown while rendering a paragraph block', () => {
    const markdown = `**${'x'.repeat(3_496)}**\n`;

    expect(chunkTelegramMarkdownAsHtml(markdown)).toEqual([
      {
        markdown,
        html: `<p><b>${'x'.repeat(3_496)}</b></p>`,
      },
    ]);
  });

  it('keeps every HTML chunk under the Telegram limit despite escape expansion', () => {
    // Angle-bracket-heavy content expands ~4x under HTML escaping, so raw
    // chunks that fit the source target can overflow once converted.
    const line = '<div><span attr="&&&">' + '&<>'.repeat(20) + '</span></div>';
    const markdown = [
      '```html',
      ...Array.from({ length: 120 }, () => line),
      '```',
    ].join('\n');
    const chunks = chunkTelegramMarkdownAsHtml(markdown);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.html.length).toBeLessThanOrEqual(
        TELEGRAM_MAX_RICH_MESSAGE_LENGTH,
      );
    }
  });

  it('preserves all content across re-chunked pieces', () => {
    const line = `payload & <tag> ${'&'.repeat(40)}`;
    const markdown = Array.from({ length: 200 }, () => line).join('\n');
    const chunks = chunkTelegramMarkdownAsHtml(markdown);

    expect(chunks.map((chunk) => chunk.markdown).join('')).toBe(markdown);
  });

  it('preserves exact newlines during recursive HTML expansion', () => {
    const markdown = `${'&'.repeat(5_000)}\n${'&'.repeat(10_000)}`;
    const chunks = chunkTelegramMarkdownAsHtml(markdown);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((chunk) => chunk.markdown).join('')).toBe(markdown);
    expect(chunks.every((chunk) => chunk.markdown.length > 0)).toBe(true);
  });
});

describe('planTelegramRichMessages', () => {
  it('keeps rendered messages above 4096 together below the rich limit', () => {
    const text = 'x'.repeat(10_000);
    expect(planTelegramRichMessages({ text })).toEqual([{ text, html: text }]);
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
        (chunk) => chunk.html.length <= TELEGRAM_MAX_RICH_MESSAGE_LENGTH,
      ),
    ).toBe(true);
    expect(
      chunks.slice(0, -1).every((chunk) => !chunk.html.includes('<footer>')),
    ).toBe(true);
    expect(chunks.at(-1)?.html).toContain(
      '<footer><a href="https://roomote.test">Open</a></footer>',
    );
  });

  it('accounts for escaping expansion when splitting plain text', () => {
    const text = '&<>'.repeat(20_000);
    const chunks = planTelegramRichMessages({ text });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((chunk) => chunk.text).join('')).toBe(text);
    expect(
      chunks.every(
        (chunk) => chunk.html.length <= TELEGRAM_MAX_RICH_MESSAGE_LENGTH,
      ),
    ).toBe(true);
  });

  it('preserves plain-text newlines with explicit rich HTML breaks', () => {
    expect(planTelegramRichMessages({ text: 'first\n\n- second' })).toEqual([
      { text: 'first\n\n- second', html: 'first<br><br>- second' },
    ]);
  });
});
