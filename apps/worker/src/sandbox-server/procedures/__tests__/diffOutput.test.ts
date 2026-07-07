import {
  buildRepoWatchTargets,
  isGitStateWatchPath,
  isGitStateWatchPathOrAncestor,
  type DiffRepoTarget,
} from '../diffOutput';

describe('diffOutput git state watch targets', () => {
  const repos: DiffRepoTarget[] = [
    { repoName: '.', repoPath: '/workspace' },
    { repoName: 'packages/app', repoPath: '/workspace/packages/app' },
  ];

  it('includes narrow git state paths for root and nested repositories', () => {
    expect(buildRepoWatchTargets('/workspace', repos)).toEqual([
      '.',
      'packages/app',
      '.git/HEAD',
      '.git/index',
      '.git/refs/heads',
      '.git/packed-refs',
      'packages/app/.git/HEAD',
      'packages/app/.git/index',
      'packages/app/.git/refs/heads',
      'packages/app/.git/packed-refs',
    ]);
  });

  it('matches git state files but not arbitrary .git contents', () => {
    expect(isGitStateWatchPath('.git/HEAD', repos, '/workspace')).toBe(true);
    expect(isGitStateWatchPath('.git/index', repos, '/workspace')).toBe(true);
    expect(
      isGitStateWatchPath('.git/refs/heads/main', repos, '/workspace'),
    ).toBe(true);
    expect(
      isGitStateWatchPath(
        'packages/app/.git/refs/heads/feature/test',
        repos,
        '/workspace',
      ),
    ).toBe(true);
    expect(isGitStateWatchPath('.git/logs/HEAD', repos, '/workspace')).toBe(
      false,
    );
    expect(
      isGitStateWatchPath('packages/app/.git/objects/abc', repos, '/workspace'),
    ).toBe(false);
  });

  it('allows git state path ancestors through the watcher ignore filter', () => {
    expect(
      isGitStateWatchPathOrAncestor('.git/refs', repos, '/workspace'),
    ).toBe(true);
    expect(
      isGitStateWatchPathOrAncestor(
        'packages/app/.git/refs',
        repos,
        '/workspace',
      ),
    ).toBe(true);
    expect(
      isGitStateWatchPathOrAncestor('.git/objects', repos, '/workspace'),
    ).toBe(false);
  });
});
