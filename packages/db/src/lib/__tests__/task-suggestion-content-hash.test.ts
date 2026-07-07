import { buildTaskSuggestionContentHash } from '../task-suggestion-content-hash';

describe('buildTaskSuggestionContentHash', () => {
  it('normalizes compatibility unicode, whitespace, case, and repository order', () => {
    const firstHash = buildTaskSuggestionContentHash({
      title: '  Fix  IV  ',
      brief: 'Tighten   launch path',
      targetRepositoryFullName: ' App ',
      repositoryIds: ['Repo-2', ' repo-1 '],
    });

    const secondHash = buildTaskSuggestionContentHash({
      title: 'Fix Ⅳ',
      brief: 'tighten launch path',
      targetRepositoryFullName: 'app',
      repositoryIds: ['repo-1', 'REPO-2'],
    });

    expect(firstHash).toBe(secondHash);
  });

  it('changes when the core suggestion content changes', () => {
    const baseParams = {
      title: 'Fix flaky deploy task',
      brief: 'Retry the sandbox bootstrap after transient controller errors.',
      targetRepositoryFullName: 'App',
      repositoryIds: ['repo-1'],
    };

    expect(buildTaskSuggestionContentHash(baseParams)).not.toBe(
      buildTaskSuggestionContentHash({
        ...baseParams,
        brief: 'Retry the sandbox bootstrap after worker errors.',
      }),
    );
  });
});
