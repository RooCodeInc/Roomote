import {
  getArtifactViewUrl,
  getSessionArtifactViewUrl,
  parseSessionArtifactSearchParams,
} from './artifact-view-urls';

describe('getArtifactViewUrl', () => {
  it('links to the task artifacts view with the path and version', () => {
    expect(
      getArtifactViewUrl('https://roomote.example', 'task-1', 'notes/a.md', 2),
    ).toBe(
      'https://roomote.example/task/task-1/artifacts?path=notes%2Fa.md&v=2',
    );
  });
});

describe('getSessionArtifactViewUrl', () => {
  it('links to the Session with the artifact path and version', () => {
    expect(
      getSessionArtifactViewUrl(
        'https://roomote.example',
        'session-1',
        'notes/decision.md',
        1,
      ),
    ).toBe(
      'https://roomote.example/sessions/session-1?artifact=notes%2Fdecision.md&v=1',
    );
  });

  it('round-trips through the search param parser', () => {
    const url = new URL(
      getSessionArtifactViewUrl('https://roomote.example', 's', 'a b/c.md', 3),
    );

    expect(parseSessionArtifactSearchParams(url.searchParams)).toEqual({
      path: 'a b/c.md',
      version: 3,
    });
  });
});

describe('parseSessionArtifactSearchParams', () => {
  it('returns null without an artifact param', () => {
    expect(parseSessionArtifactSearchParams(new URLSearchParams('v=1'))).toBe(
      null,
    );
    expect(
      parseSessionArtifactSearchParams(new URLSearchParams('artifact=')),
    ).toBe(null);
  });

  it('drops versions that are not positive integers', () => {
    for (const v of ['', '0', '-1', '1.5', 'latest']) {
      expect(
        parseSessionArtifactSearchParams(
          new URLSearchParams({ artifact: 'notes/a.md', v }),
        ),
      ).toEqual({ path: 'notes/a.md' });
    }
    expect(
      parseSessionArtifactSearchParams(new URLSearchParams('artifact=a.md')),
    ).toEqual({ path: 'a.md' });
  });
});
