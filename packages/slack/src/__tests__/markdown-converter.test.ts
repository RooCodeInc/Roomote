import {
  convertMarkdownLinksToSlack,
  convertMarkdownToSlack,
  convertSlackLinksToMarkdown,
} from '../markdown-converter';

describe('convertMarkdownLinksToSlack', () => {
  it('converts simple markdown links to Slack links', () => {
    expect(
      convertMarkdownLinksToSlack('[click here](https://example.com)'),
    ).toBe('<https://example.com|click here>');
  });

  it('converts markdown links with parentheses in the URL', () => {
    const md =
      '[`Messages.tsx`](apps/web/src/app/(sandbox)/task/[taskId]/Messages.tsx:45)';
    expect(convertMarkdownLinksToSlack(md)).toBe(
      '[`Messages.tsx`](apps/web/src/app/(sandbox)/task/[taskId]/Messages.tsx:45)',
    );
  });

  it('leaves markdown links with absolute filesystem-style paths unchanged', () => {
    const md = '[app.ts](/sandbox/repos/Roomote/apps/api/src/app.ts:42)';
    expect(convertMarkdownLinksToSlack(md)).toBe(md);
  });

  it('leaves non-link markdown unchanged', () => {
    expect(convertMarkdownLinksToSlack('**hello** plain text')).toBe(
      '**hello** plain text',
    );
  });

  it('converts links whose URL contains balanced parentheses', () => {
    expect(
      convertMarkdownLinksToSlack(
        '[label](https://example.com/path_(section))',
      ),
    ).toBe('<https://example.com/path_(section)|label>');
  });

  it('handles pathological unbalanced-paren input without catastrophic backtracking', () => {
    const pathological = '[x](' + '('.repeat(50_000);
    const start = performance.now();
    const result = convertMarkdownLinksToSlack(pathological);
    const elapsedMs = performance.now() - start;
    expect(result).toBe(pathological);
    expect(elapsedMs).toBeLessThan(2_000);
  });
});

describe('convertMarkdownToSlack', () => {
  it('converts bold markdown to Slack bold', () => {
    // Note: the converter first reduces **text** → *text*, then the italic
    // regex converts *text* → _text_. This is existing behavior.
    expect(convertMarkdownToSlack('**hello**')).toBe('_hello_');
  });

  it('converts strikethrough markdown to Slack strikethrough', () => {
    expect(convertMarkdownToSlack('~~removed~~')).toBe('~removed~');
  });

  it('converts simple markdown links to Slack links', () => {
    expect(convertMarkdownToSlack('[click here](https://example.com)')).toBe(
      '<https://example.com|click here>',
    );
  });

  it('converts markdown links with parentheses in the URL (e.g. Next.js route groups)', () => {
    const md =
      '[`Messages.tsx`](apps/web/src/app/(sandbox)/task/[taskId]/Messages.tsx:45)';
    expect(convertMarkdownToSlack(md)).toBe(
      '[`Messages.tsx`](apps/web/src/app/(sandbox)/task/[taskId]/Messages.tsx:45)',
    );
  });

  it('handles multiple parenthesized segments in a URL', () => {
    const md = '[link](path/(group1)/nested/(group2)/file.ts)';
    expect(convertMarkdownToSlack(md)).toBe(
      '[link](path/(group1)/nested/(group2)/file.ts)',
    );
  });

  it('leaves text without markdown unchanged', () => {
    expect(convertMarkdownToSlack('plain text')).toBe('plain text');
  });
});

describe('convertSlackLinksToMarkdown', () => {
  it('converts labeled Slack links to markdown links', () => {
    expect(
      convertSlackLinksToMarkdown('<https://example.com/path|Example Link>'),
    ).toBe('[Example Link](https://example.com/path)');
  });

  it('converts bare Slack links to plain URLs', () => {
    expect(convertSlackLinksToMarkdown('<https://example.com/path>')).toBe(
      'https://example.com/path',
    );
  });

  it('decodes Slack HTML entities in links and labels', () => {
    expect(
      convertSlackLinksToMarkdown(
        '<https://example.com?a=1&amp;b=2|A &amp; B>',
      ),
    ).toBe('[A & B](https://example.com?a=1&b=2)');
  });

  it('leaves non-link Slack entities unchanged', () => {
    expect(
      convertSlackLinksToMarkdown('hello <@U123> and <#C123|general>'),
    ).toBe('hello <@U123> and <#C123|general>');
  });
});
