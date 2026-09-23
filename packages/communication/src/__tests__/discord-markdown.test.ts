import { describe, expect, it } from 'vitest';

import {
  chunkDiscordMessage,
  truncateDiscordMessage,
} from '../discord-provider';
import { renderDiscordMarkdownTables } from '../discord-markdown';

describe('renderDiscordMarkdownTables', () => {
  it('renders wide GFM comparisons as padded ASCII grids with plain-text cells', () => {
    const input = [
      'Comparison follows.',
      '',
      '| Provider | Context | Features | Price |',
      '| --- | :---: | ---: | --- |',
      '| Cloud\\|Host | `1m | api` | **Fast** / [docs](https://example.test/docs_with_ids) / `**code**` | $1 |',
      '| Other | 128k | _Batch_ | $2 |',
      '',
      'End of comparison.',
    ].join('\n');

    const rendered = renderDiscordMarkdownTables(input);
    const lines = rendered.split('\n');
    const opening = lines.findIndex((line) => line === '```');
    const closing = lines.findIndex(
      (line, index) => index > opening && line === '```',
    );
    const tableLines = lines.slice(opening + 1, closing);

    expect(rendered).toContain('Comparison follows.\n\n```');
    expect(rendered).toContain('End of comparison.');
    expect(rendered).toContain('Cloud|Host');
    expect(rendered).toContain('1m | api');
    expect(rendered).toContain('Fast');
    expect(rendered).toContain('docs (https://example.test/docs_with_ids)');
    expect(rendered).toContain('**code**');
    expect(rendered).not.toContain('**Fast**');
    expect(rendered).not.toContain('`1m');
    expect(new Set(tableLines.map((line) => line.length)).size).toBe(1);
    expect(tableLines[0]).toMatch(/^\+/u);
    expect(tableLines[2]).toMatch(/^\+.*\+.*/u);
    expect(tableLines[2]).toContain('=');
  });

  it('leaves existing fenced and indented code tables untouched', () => {
    const input = [
      '```md',
      '| A | B |',
      '| --- | --- |',
      '| raw | table |',
      '```',
      '',
      '    | also | code |',
      '    | --- | --- |',
      '    | raw | table |',
    ].join('\n');

    expect(renderDiscordMarkdownTables(input)).toBe(input);
  });

  it('uses a longer output fence when a cell contains a literal backtick fence', () => {
    const input =
      '| Name | Notes |\n| --- | --- |\n| Alpha | ```` literal ``` token ```` |';

    const rendered = renderDiscordMarkdownTables(input);

    expect(rendered.startsWith('````\n')).toBe(true);
    expect(rendered).toContain('literal ``` token');
    expect(rendered.endsWith('\n````')).toBe(true);
  });

  it('preserves escaped backticks as literal cell text', () => {
    const input =
      '| Name | Notes |\n| --- | --- |\n| Alpha | use \\`raw\\` ticks |';

    expect(renderDiscordMarkdownTables(input)).toContain('use `raw` ticks');
  });

  it('renders HTML-like cell text safely and decodes entities only once', () => {
    const input =
      '| Name | Notes |\n| --- | --- |\n| Alpha | <script>alert(1)</script> &amp; &amp;lt;script&amp;gt; |';

    const rendered = renderDiscordMarkdownTables(input);

    expect(rendered).not.toContain('<script');
    expect(rendered).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(rendered).toContain('& &lt;script&gt;');
  });

  it('leaves malformed tables unchanged rather than dropping extra cells', () => {
    const malformed = [
      '| Name | Value |',
      '| --- | --- |',
      '| one | two | three |',
    ].join('\n');
    const invalidSeparator = '| Name | Value |\n| --- | no |\n| one | two |';

    expect(renderDiscordMarkdownTables(malformed)).toBe(malformed);
    expect(renderDiscordMarkdownTables(invalidSeparator)).toBe(
      invalidSeparator,
    );
  });

  it('keeps generated table fences balanced and chunks them within Discord limits', () => {
    const rows = Array.from(
      { length: 180 },
      (_, index) => `| Provider ${index} | ${'value '.repeat(12)} |`,
    );
    const text = [
      'Comparison:',
      '',
      '| Provider | Notes |',
      '| --- | --- |',
      ...rows,
      '',
      'End of comparison.',
    ].join('\n');

    const chunks = chunkDiscordMessage(text);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 2_000)).toBe(true);
    for (const [index, chunk] of chunks.entries()) {
      const fenceLines = chunk.split('\n').filter((line) => line === '```');
      expect(fenceLines).toHaveLength(2);
      expect(chunk).toContain('| Provider');
      if (index === 0) expect(chunk).toContain('Comparison:');
      if (index === chunks.length - 1) {
        expect(chunk).toContain('End of comparison.');
      }
    }
    expect(chunks.join('\n')).toContain('Provider 179');
    expect(chunks.join('\n')).toContain('value');
  });

  it('keeps oversized wrapped table rows in header-repeated chunks', () => {
    const longValue = 'x'.repeat(6_000);
    const input = `| Provider | Details |\n| --- | --- |\n| Long | ${longValue} |`;

    const chunks = chunkDiscordMessage(input);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 2_000)).toBe(true);
    expect(chunks.every((chunk) => chunk.includes('| Provider'))).toBe(true);
    expect(
      chunks.reduce(
        (count, chunk) => count + (chunk.match(/x/gu)?.length ?? 0),
        0,
      ),
    ).toBe(longValue.length);
  });

  it('wraps wide headers within the per-message grid budget instead of keeping GFM raw', () => {
    const headerA = 'H'.repeat(200);
    const headerB = 'M'.repeat(200);
    const valueA = 'C'.repeat(200);
    const valueB = 'D'.repeat(200);
    const input = `| ${headerA} | ${headerB} |\n| --- | --- |\n| ${valueA} | ${valueB} |`;

    const rendered = renderDiscordMarkdownTables(input);
    const chunks = chunkDiscordMessage(input);

    expect(rendered).not.toBe(input);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 2_000)).toBe(true);
    expect(chunks.every((chunk) => chunk.includes(headerA.slice(0, 80)))).toBe(
      true,
    );
    expect(chunks.every((chunk) => chunk.includes(headerB.slice(0, 80)))).toBe(
      true,
    );
    expect(
      chunks.reduce(
        (count, chunk) => count + (chunk.match(/C/gu)?.length ?? 0),
        0,
      ),
    ).toBe(valueA.length);
    expect(
      chunks.reduce(
        (count, chunk) => count + (chunk.match(/D/gu)?.length ?? 0),
        0,
      ),
    ).toBe(valueB.length);
  });

  it('keeps forum-starter tables when the preamble does not fit beside a table chunk', () => {
    const rows = Array.from({ length: 60 }, (_, index) => `| P${index} | x |`);
    const preamble = 'Comparison notes. '.repeat(28);
    const input = [
      preamble,
      '',
      '| Provider | Value |',
      '| --- | --- |',
      ...rows,
    ].join('\n');
    expect(input.length).toBeLessThan(2_000);
    expect(renderDiscordMarkdownTables(input).length).toBeGreaterThan(2_000);

    const starter = truncateDiscordMessage(input);

    expect(starter.length).toBeLessThanOrEqual(2_000);
    expect(starter).toContain('Comparison notes.');
    expect(starter).toContain('| Provider');
    expect(starter).toContain('P0');
    expect(starter.split('\n').filter((line) => line === '```')).toHaveLength(
      2,
    );
  });

  it('keeps oversized existing code fences balanced without losing their tail', () => {
    const input = '```text\n' + 'literal ``` marker '.repeat(180) + 'END';

    const chunks = chunkDiscordMessage(input);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 2_000)).toBe(true);
    expect(chunks.every((chunk) => chunk.startsWith('```text\n'))).toBe(true);
    expect(chunks.every((chunk) => chunk.endsWith('\n```'))).toBe(true);
    expect(chunks.join('\n')).toContain('END');
  });
});
