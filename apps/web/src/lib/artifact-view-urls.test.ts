import {
  getArtifactViewUrl,
  getSessionArtifactsViewUrl,
  getSessionArtifactViewUrl,
  getSessionTaskArtifactViewUrl,
  getStandaloneArtifactViewUrl,
  hasSessionArtifactsSearchParams,
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

describe('getStandaloneArtifactViewUrl', () => {
  it('encodes task ownership in the path', () => {
    expect(
      getStandaloneArtifactViewUrl(
        'https://roomote.example',
        { taskId: 'task/1' },
        'notes/a b.md',
        2,
      ),
    ).toBe(
      'https://roomote.example/artifacts/task/task%2F1?path=notes%2Fa+b.md&v=2',
    );
  });

  it('encodes Session ownership in the path', () => {
    expect(
      getStandaloneArtifactViewUrl(
        'https://roomote.example',
        { sessionId: 'session-1' },
        'proof/image.png',
        3,
      ),
    ).toBe(
      'https://roomote.example/artifacts/session/session-1?path=proof%2Fimage.png&v=3',
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

describe('Session artifact panel URLs', () => {
  it('links to the Session artifacts gallery', () => {
    expect(
      getSessionArtifactsViewUrl('https://roomote.example', 'session-1'),
    ).toBe('https://roomote.example/sessions/session-1?panel=artifacts');
  });

  it('round-trips a task-owned artifact in the Session viewer', () => {
    const url = new URL(
      getSessionTaskArtifactViewUrl(
        'https://roomote.example',
        'session-1',
        'task-1',
        'reports/result.md',
        2,
      ),
    );

    expect(parseSessionArtifactSearchParams(url.searchParams)).toEqual({
      path: 'reports/result.md',
      taskId: 'task-1',
      version: 2,
    });
    expect(hasSessionArtifactsSearchParams(url.searchParams)).toBe(true);
  });

  it('recognizes a gallery-only link without selecting an artifact', () => {
    const params = new URLSearchParams('panel=artifacts');
    expect(hasSessionArtifactsSearchParams(params)).toBe(true);
    expect(parseSessionArtifactSearchParams(params)).toBeNull();
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
