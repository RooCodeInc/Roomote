import {
  areAllRepositoriesEmpty,
  getEmptyRepositories,
  isRepositoryEmpty,
} from '../repositories';

describe('repository empty state helpers', () => {
  it('treats only explicit empty repositories as having no commits', () => {
    expect(isRepositoryEmpty({ isEmpty: true })).toBe(true);
    expect(isRepositoryEmpty({ isEmpty: false })).toBe(false);
    expect(isRepositoryEmpty({ isEmpty: undefined })).toBe(false);
    expect(isRepositoryEmpty({ isEmpty: null })).toBe(false);
  });

  it('returns only repositories that have no commits', () => {
    expect(
      getEmptyRepositories([
        { id: 'repo-1', fullName: 'acme/api', isEmpty: false },
        { id: 'repo-2', fullName: 'acme/empty', isEmpty: true },
        { id: 'repo-3', fullName: 'acme/web' },
      ]),
    ).toEqual([{ id: 'repo-2', fullName: 'acme/empty', isEmpty: true }]);
  });

  it('requires every selected repository to be empty before warning', () => {
    expect(
      areAllRepositoriesEmpty([{ isEmpty: true }, { isEmpty: true }]),
    ).toBe(true);
    expect(
      areAllRepositoriesEmpty([{ isEmpty: true }, { isEmpty: false }]),
    ).toBe(false);
    expect(areAllRepositoriesEmpty([])).toBe(false);
  });
});
