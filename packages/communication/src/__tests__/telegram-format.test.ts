import { describe, expect, it } from 'vitest';

import {
  TELEGRAM_MAX_MESSAGE_LENGTH,
  chunkTelegramMarkdown,
  chunkTelegramMarkdownAsHtml,
  markdownToTelegramHtml,
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
      '<b>Summary</b>\ndone',
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
      markdownToTelegramHtml('set TELEGRAM_BOT_TOKEN and my_var_name'),
    ).toBe('set TELEGRAM_BOT_TOKEN and my_var_name');
  });

  it('italicizes whole lines wrapped in underscores (footer style)', () => {
    expect(
      markdownToTelegramHtml('_Reply or use the [web app](https://a.test)._'),
    ).toBe('<i>Reply or use the <a href="https://a.test">web app</a>.</i>');
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
    expect(chunks.join('\n')).toBe(lines.join('\n'));
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
});

describe('chunkTelegramMarkdownAsHtml', () => {
  it('returns a single converted chunk for short markdown', () => {
    expect(chunkTelegramMarkdownAsHtml('**hi**')).toEqual([
      { markdown: '**hi**', html: '<b>hi</b>' },
    ]);
  });

  it('keeps every HTML chunk under the Telegram limit despite escape expansion', () => {
    // Angle-bracket-heavy content expands ~4x under HTML escaping, so raw
    // chunks that fit the markdown target can overflow 4096 once converted.
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
        TELEGRAM_MAX_MESSAGE_LENGTH,
      );
      expect(chunk.markdown.length).toBeLessThanOrEqual(
        TELEGRAM_MAX_MESSAGE_LENGTH,
      );
    }
  });

  it('preserves all content across re-chunked pieces', () => {
    const line = `payload & <tag> ${'&'.repeat(40)}`;
    const markdown = Array.from({ length: 200 }, () => line).join('\n');
    const chunks = chunkTelegramMarkdownAsHtml(markdown);

    expect(chunks.map((chunk) => chunk.markdown).join('\n')).toBe(markdown);
  });
});
