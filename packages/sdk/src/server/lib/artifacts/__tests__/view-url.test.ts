import { buildStandaloneArtifactViewUrl } from '../view-url';

describe('buildStandaloneArtifactViewUrl', () => {
  it.each([
    [
      { taskId: 'task/1' },
      'https://roomote.example/artifacts/task/task%2F1?path=notes%2Fa+b.md&v=2',
    ],
    [
      { sessionId: 'session/1' },
      'https://roomote.example/artifacts/session/session%2F1?path=notes%2Fa+b.md&v=2',
    ],
  ])('builds a standalone viewer URL for owner %o', (owner, expected) => {
    expect(
      buildStandaloneArtifactViewUrl(
        'https://roomote.example/',
        owner,
        'notes/a b.md',
        2,
      ),
    ).toBe(expected);
  });
});
