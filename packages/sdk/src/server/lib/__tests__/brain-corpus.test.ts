import { extractBrainCorpusPages } from '../brain-corpus';

describe('extractBrainCorpusPages', () => {
  it('reads a bare array of page objects', () => {
    expect(
      extractBrainCorpusPages([
        [
          {
            slug: 'tasks/run-1',
            title: 'Fixed the drainer',
            updated_at: '2026-01-02T03:04:05Z',
          },
        ],
      ]),
    ).toEqual([
      {
        slug: 'tasks/run-1',
        title: 'Fixed the drainer',
        updatedAt: new Date('2026-01-02T03:04:05Z'),
      },
    ]);
  });

  it('reads pages wrapped under the key the tool happened to use', () => {
    const fromPages = extractBrainCorpusPages([
      { pages: [{ slug: 'slack/T1/C1/2026-01-02' }] },
    ]);
    const fromResults = extractBrainCorpusPages([
      { results: [{ slug: 'slack/T1/C1/2026-01-02' }] },
    ]);

    expect(fromPages).toEqual(fromResults);
    expect(fromPages[0]?.slug).toBe('slack/T1/C1/2026-01-02');
  });

  it('falls back to slugs listed as plain text', () => {
    expect(
      extractBrainCorpusPages(['people/member-a\npeople/member-b\n']).map(
        (page) => page.slug,
      ),
    ).toEqual(['people/member-a', 'people/member-b']);
  });

  it('keeps one entry per slug when the same page arrives twice', () => {
    // gbrain answers with both structured content and a text rendering of the
    // same result, so every payload is scanned and duplicates are expected.
    expect(
      extractBrainCorpusPages([
        [{ slug: 'tasks/run-1', title: 'Structured' }],
        [{ slug: 'tasks/run-1', title: 'Text copy' }],
      ]),
    ).toHaveLength(1);
  });

  it('accepts a page whose date is missing or unparseable', () => {
    const [page] = extractBrainCorpusPages([
      [{ slug: 'notion/page-1', updated_at: 'sometime' }],
    ]);

    expect(page?.updatedAt).toBeNull();
    expect(page?.title).toBeNull();
  });

  it('ignores entries that do not identify a page', () => {
    expect(
      extractBrainCorpusPages([[{ title: 'no slug' }, '', null, 42]]),
    ).toEqual([]);
  });
});
