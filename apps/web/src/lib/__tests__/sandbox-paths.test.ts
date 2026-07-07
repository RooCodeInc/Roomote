import {
  SANDBOX_REPO_PATH_PREFIX,
  sanitizeSandboxPathsForDisplay,
  sanitizeSandboxPathString,
} from '../sandbox-paths';

describe('sandbox-paths', () => {
  it('strips the sandbox repo prefix from a full path', () => {
    expect(
      sanitizeSandboxPathString('/sandbox/repos/Roomote/apps/web/src/file.ts'),
    ).toBe('Roomote/apps/web/src/file.ts');
  });

  it('strips every sandbox repo prefix occurrence in command-like strings', () => {
    expect(
      sanitizeSandboxPathString(
        `cat ${SANDBOX_REPO_PATH_PREFIX}Roomote/README.md && ls ${SANDBOX_REPO_PATH_PREFIX}Roomote/apps/web`,
      ),
    ).toBe('cat Roomote/README.md && ls Roomote/apps/web');
  });

  it('deeply sanitizes nested arrays and objects', () => {
    const input = {
      path: '/sandbox/repos/Roomote/apps/web/src/task.tsx',
      nested: {
        files: ['/sandbox/repos/Roomote/apps/api/src/index.ts', 'no-change'],
      },
      count: 1,
      enabled: true,
      empty: null,
    };

    expect(sanitizeSandboxPathsForDisplay(input)).toEqual({
      path: 'Roomote/apps/web/src/task.tsx',
      nested: {
        files: ['Roomote/apps/api/src/index.ts', 'no-change'],
      },
      count: 1,
      enabled: true,
      empty: null,
    });
  });
});
