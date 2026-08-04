// pnpm --filter @roomote/db exec vitest run src/lib/__tests__/source-control-provider.test.ts
import type { DatabaseOrTransaction } from '../../db';
import {
  resolveWorkspaceRepositoryProviders,
  resolveWorkspaceSourceControlProvider,
} from '../source-control-provider';

const mockWhere = vi.fn();
const mockOrderBy = vi.fn();
let mockRows: Array<{
  fullName: string;
  host: string | null;
  sourceControlProvider: 'github' | 'gitlab' | 'gitea' | 'ado' | 'bitbucket';
}> = [];

const query = {
  innerJoin: vi.fn(() => query),
  where: vi.fn((...args: unknown[]) => {
    mockWhere(...args);
    return query;
  }),
  orderBy: vi.fn((...args: unknown[]) => {
    mockOrderBy(...args);
    return Promise.resolve(mockRows);
  }),
  then: (
    resolve: (value: typeof mockRows) => unknown,
    reject: (reason: unknown) => unknown,
  ) => Promise.resolve(mockRows).then(resolve, reject),
};

const dbOrTx = {
  select: vi.fn(() => ({
    from: vi.fn(() => query),
  })),
} as unknown as DatabaseOrTransaction;

describe('resolveWorkspaceSourceControlProvider', () => {
  beforeEach(() => {
    mockRows = [];
    mockWhere.mockReset();
    mockOrderBy.mockReset();
  });

  it('resolves the provider from an environment with a single-provider mapping', async () => {
    mockRows = [
      {
        fullName: 'acme/Platform/backend',
        host: 'dev.azure.com',
        sourceControlProvider: 'ado',
      },
    ];

    await expect(
      resolveWorkspaceSourceControlProvider(dbOrTx, {
        type: 'environment',
        environmentId: 'env-1',
      }),
    ).resolves.toBe('ado');
  });

  it('resolves the provider from a single repository workspace', async () => {
    mockRows = [
      {
        fullName: 'group/subgroup/repo',
        host: 'gitlab.com',
        sourceControlProvider: 'gitlab',
      },
    ];

    await expect(
      resolveWorkspaceSourceControlProvider(dbOrTx, {
        type: 'repository',
        repo: 'group/subgroup/repo',
      }),
    ).resolves.toBe('gitlab');
  });

  it('resolves the provider from a repository set sharing one provider', async () => {
    mockRows = [
      {
        fullName: 'acme/Platform/frontend',
        host: 'dev.azure.com',
        sourceControlProvider: 'ado',
      },
      {
        fullName: 'acme/Platform/backend',
        host: 'dev.azure.com',
        sourceControlProvider: 'ado',
      },
    ];

    await expect(
      resolveWorkspaceSourceControlProvider(dbOrTx, {
        type: 'repository_set',
        repositories: ['acme/Platform/backend', 'acme/Platform/frontend'],
      }),
    ).resolves.toBe('ado');
  });

  it('returns undefined when the workspace spans multiple providers', async () => {
    mockRows = [
      {
        fullName: 'acme/Platform/backend',
        host: 'dev.azure.com',
        sourceControlProvider: 'ado',
      },
      {
        fullName: 'octo/web',
        host: 'github.com',
        sourceControlProvider: 'github',
      },
    ];

    await expect(
      resolveWorkspaceSourceControlProvider(dbOrTx, {
        type: 'all_repositories',
      }),
    ).resolves.toBeUndefined();
  });

  it('returns undefined when no repository rows match', async () => {
    await expect(
      resolveWorkspaceSourceControlProvider(dbOrTx, {
        type: 'repository',
        repo: 'owner/unknown',
      }),
    ).resolves.toBeUndefined();
  });

  it('returns undefined for an empty repository set without querying', async () => {
    await expect(
      resolveWorkspaceSourceControlProvider(dbOrTx, {
        type: 'repository_set',
        repositories: [],
      }),
    ).resolves.toBeUndefined();
    expect(mockWhere).not.toHaveBeenCalled();
  });

  it('returns a mixed-provider map in repository workspace order', async () => {
    mockRows = [
      {
        fullName: 'group/web',
        host: 'gitlab.com',
        sourceControlProvider: 'gitlab',
      },
      {
        fullName: 'octo/api',
        host: 'github.com',
        sourceControlProvider: 'github',
      },
    ];

    await expect(
      resolveWorkspaceRepositoryProviders(dbOrTx, {
        type: 'repository_set',
        repositories: ['octo/api', 'group/web'],
      }),
    ).resolves.toEqual({
      'octo/api': 'github',
      'group/web': 'gitlab',
    });
  });

  it('uses sourceControlHost to disambiguate same-name repository rows', async () => {
    mockRows = [
      {
        fullName: 'group/project',
        host: 'gitlab.alpha.example',
        sourceControlProvider: 'gitlab',
      },
      {
        fullName: 'group/project',
        host: 'git.example.com',
        sourceControlProvider: 'gitea',
      },
    ];

    await expect(
      resolveWorkspaceRepositoryProviders(dbOrTx, {
        type: 'repository',
        repo: 'group/project',
        sourceControlHost: 'git.example.com',
      }),
    ).resolves.toEqual({ 'group/project': 'gitea' });
  });

  it('omits and logs ambiguous same-name repository rows', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockRows = [
      {
        fullName: 'group/project',
        host: 'gitlab.alpha.example',
        sourceControlProvider: 'gitlab',
      },
      {
        fullName: 'group/project',
        host: 'gitlab.beta.example',
        sourceControlProvider: 'gitlab',
      },
    ];

    await expect(
      resolveWorkspaceRepositoryProviders(dbOrTx, {
        type: 'repository',
        repo: 'group/project',
      }),
    ).resolves.toEqual({});
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Omitting ambiguous repository group/project'),
    );
    warn.mockRestore();
  });
});
