import {
  convertMarkdownInlineToRichText,
  convertMarkdownToRichText,
} from '../markdown-rich-text';

describe('convertMarkdownInlineToRichText', () => {
  it('styles bold, italic, strikethrough, and code', () => {
    expect(
      convertMarkdownInlineToRichText(
        "I'll add a **peacock** with _care_, ~~a goose~~, and `bird.ts`.",
      ),
    ).toEqual([
      { type: 'text', text: "I'll add a " },
      { type: 'text', text: 'peacock', style: { bold: true } },
      { type: 'text', text: ' with ' },
      { type: 'text', text: 'care', style: { italic: true } },
      { type: 'text', text: ', ' },
      { type: 'text', text: 'a goose', style: { strike: true } },
      { type: 'text', text: ', and ' },
      { type: 'text', text: 'bird.ts', style: { code: true } },
      { type: 'text', text: '.' },
    ]);
  });

  it('nests styles and converts markdown, Slack, and bare links', () => {
    expect(
      convertMarkdownInlineToRichText(
        '**See [the PR](https://github.com/x/y/pull/1)** or <https://a.io|A> or https://b.io/path',
      ),
    ).toEqual([
      { type: 'text', text: 'See ', style: { bold: true } },
      {
        type: 'link',
        url: 'https://github.com/x/y/pull/1',
        text: 'the PR',
        style: { bold: true },
      },
      { type: 'text', text: ' or ' },
      { type: 'link', url: 'https://a.io', text: 'A' },
      { type: 'text', text: ' or ' },
      { type: 'link', url: 'https://b.io/path' },
    ]);
  });

  it('leaves snake_case and arithmetic alone', () => {
    expect(
      convertMarkdownInlineToRichText('set slack_user_id to 2*3*4'),
    ).toEqual([{ type: 'text', text: 'set slack_user_id to 2*3*4' }]);
    expect(convertMarkdownInlineToRichText('5 * 3 * 2 = 30')).toEqual([
      { type: 'text', text: '5 * 3 * 2 = 30' },
    ]);
    expect(
      convertMarkdownInlineToRichText('Added __init__ and __repr__ to Model'),
    ).toEqual([{ type: 'text', text: 'Added __init__ and __repr__ to Model' }]);
  });

  it('keeps balanced parentheses inside markdown link targets', () => {
    expect(
      convertMarkdownInlineToRichText(
        'See [spec](https://en.wikipedia.org/wiki/Foo_(bar)) for details',
      ),
    ).toEqual([
      { type: 'text', text: 'See ' },
      {
        type: 'link',
        url: 'https://en.wikipedia.org/wiki/Foo_(bar)',
        text: 'spec',
      },
      { type: 'text', text: ' for details' },
    ]);
  });

  it('normalizes angle-bracket Markdown link destinations', () => {
    expect(
      convertMarkdownInlineToRichText(
        '[Finding](<https://x.com/example/status/1>)',
      ),
    ).toEqual([
      {
        type: 'text',
        text: '[Finding](<https://x.com/example/status/1>)',
      },
    ]);
    expect(
      convertMarkdownInlineToRichText(
        '[Finding](<https://x.com/example/status/1>)',
        {},
        { angleBracketLinkDestinations: true },
      ),
    ).toEqual([
      {
        type: 'link',
        url: 'https://x.com/example/status/1',
        text: 'Finding',
      },
    ]);
  });

  it('leaves sentence punctuation after a bare URL out of the link', () => {
    expect(
      convertMarkdownInlineToRichText(
        'Opened https://github.com/o/r/pull/12. Then https://a.io/docs, done (https://b.io).',
      ),
    ).toEqual([
      { type: 'text', text: 'Opened ' },
      { type: 'link', url: 'https://github.com/o/r/pull/12' },
      { type: 'text', text: '. Then ' },
      { type: 'link', url: 'https://a.io/docs' },
      { type: 'text', text: ', done (' },
      { type: 'link', url: 'https://b.io' },
      { type: 'text', text: ').' },
    ]);
  });
});

describe('convertMarkdownToRichText', () => {
  it('renders paragraphs, headings, lists, and fenced code as blocks', () => {
    expect(
      convertMarkdownToRichText(
        [
          '## Plan',
          'First line.',
          '',
          '- one **bold**',
          '- two',
          '1. first',
          '2) second',
          '```',
          'const x = 1;',
          '```',
        ].join('\n'),
      ),
    ).toEqual({
      type: 'rich_text',
      elements: [
        {
          type: 'rich_text_section',
          elements: [{ type: 'text', text: 'Plan', style: { bold: true } }],
        },
        {
          type: 'rich_text_section',
          elements: [{ type: 'text', text: 'First line.' }],
        },
        {
          type: 'rich_text_list',
          style: 'bullet',
          elements: [
            {
              type: 'rich_text_section',
              elements: [
                { type: 'text', text: 'one ' },
                { type: 'text', text: 'bold', style: { bold: true } },
              ],
            },
            {
              type: 'rich_text_section',
              elements: [{ type: 'text', text: 'two' }],
            },
          ],
        },
        {
          type: 'rich_text_list',
          style: 'ordered',
          elements: [
            {
              type: 'rich_text_section',
              elements: [{ type: 'text', text: 'first' }],
            },
            {
              type: 'rich_text_section',
              elements: [{ type: 'text', text: 'second' }],
            },
          ],
        },
        {
          type: 'rich_text_preformatted',
          elements: [{ type: 'text', text: 'const x = 1;' }],
        },
      ],
    });
  });

  it('never returns an empty rich_text entity', () => {
    expect(convertMarkdownToRichText('   \n\n')).toEqual({
      type: 'rich_text',
      elements: [
        { type: 'rich_text_section', elements: [{ type: 'text', text: '' }] },
      ],
    });
  });
});
