// pnpm --filter @roomote/db exec vitest run src/lib/__tests__/source-control-provider.test.ts
import type { DatabaseOrTransaction } from '../../db';
import {
  resolveWorkspaceRepositoryProviders,
  resolveWorkspaceSourceControlProvider,
  workspaceAllowsPrivateAttribution,
  workspaceUsesOnlySourceControlProvider,
} from '../source-control-provider';

const mockWhere = vi.fn();
const mockOrderBy = vi.fn();
let mockRows: Array<{
  fullName: string;
  host: string | null;
  isActive?: boolean;
  private?: boolean;
  sourceControlProvider: 'github' | 'gitlab' | 'gitea' | 'ado' | 'bitbucket';
}> = [];
let mockEnvironmentRepositories: string[] = [];

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
  query: {
    environments: {
      findFirst: vi.fn(async () => ({
        config: {
          name: 'Test environment',
          repositories: mockEnvironmentRepositories.map((repository) => ({
            repository,
          })),
        },
      })),
    },
  },
} as unknown as DatabaseOrTransaction;

describe('resolveWorkspaceSourceControlProvider', () => {
  beforeEach(() => {
    mockRows = [];
    mockEnvironmentRepositories = [];
    mockWhere.mockReset();
    mockOrderBy.mockReset();
  });

  it('resolves the provider from an environment with a single-provider mapping', async () => {
    mockEnvironmentRepositories = ['acme/Platform/backend'];
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

  it('orders environment providers by the declared repository config', async () => {
    mockEnvironmentRepositories = ['group/web', 'octo/api'];
    mockRows = [
      {
        fullName: 'octo/api',
        host: 'github.com',
        sourceControlProvider: 'github',
      },
      {
        fullName: 'group/web',
        host: 'gitlab.com',
        sourceControlProvider: 'gitlab',
      },
    ];

    await expect(
      resolveWorkspaceRepositoryProviders(dbOrTx, {
        type: 'environment',
        environmentId: 'env-1',
      }),
    ).resolves.toEqual({
      'group/web': 'gitlab',
      'octo/api': 'github',
    });
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

  it('prefers active rows over stale inactive rows with the same name', async () => {
    mockRows = [
      {
        fullName: 'group/project',
        host: 'gitlab.example.com',
        isActive: false,
        sourceControlProvider: 'gitlab',
      },
      {
        fullName: 'group/project',
        host: 'github.com',
        isActive: true,
        sourceControlProvider: 'github',
      },
    ];

    await expect(
      resolveWorkspaceRepositoryProviders(dbOrTx, {
        type: 'repository',
        repo: 'group/project',
      }),
    ).resolves.toEqual({ 'group/project': 'github' });
  });

  it('falls back to inactive rows when no active row matches', async () => {
    mockRows = [
      {
        fullName: 'group/project',
        host: 'gitlab.example.com',
        isActive: false,
        sourceControlProvider: 'gitlab',
      },
    ];

    await expect(
      resolveWorkspaceRepositoryProviders(dbOrTx, {
        type: 'repository',
        repo: 'group/project',
      }),
    ).resolves.toEqual({ 'group/project': 'gitlab' });
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

describe('workspaceAllowsPrivateAttribution', () => {
  beforeEach(() => {
    mockRows = [];
    mockEnvironmentRepositories = [];
  });

  it('allows account names only when every selected repository is private', async () => {
    mockRows = [
      {
        fullName: 'octo/api',
        host: 'github.com',
        private: true,
        sourceControlProvider: 'github',
      },
      {
        fullName: 'octo/web',
        host: 'github.com',
        private: true,
        sourceControlProvider: 'github',
      },
    ];

    await expect(
      workspaceAllowsPrivateAttribution(dbOrTx, {
        type: 'repository_set',
        repositories: ['octo/api', 'octo/web'],
      }),
    ).resolves.toBe(true);
  });

  it('uses public-safe attribution for mixed-visibility workspaces', async () => {
    mockRows = [
      {
        fullName: 'octo/private',
        host: 'github.com',
        private: true,
        sourceControlProvider: 'github',
      },
      {
        fullName: 'octo/public',
        host: 'github.com',
        private: false,
        sourceControlProvider: 'github',
      },
    ];

    await expect(
      workspaceAllowsPrivateAttribution(dbOrTx, {
        type: 'repository_set',
        repositories: ['octo/private', 'octo/public'],
      }),
    ).resolves.toBe(false);
  });

  it('uses public-safe attribution when a repository cannot be resolved', async () => {
    await expect(
      workspaceAllowsPrivateAttribution(dbOrTx, {
        type: 'repository',
        repo: 'octo/missing',
      }),
    ).resolves.toBe(false);
  });

  it('requires every repository to match before using a provider handle', async () => {
    mockRows = [
      {
        fullName: 'octo/api',
        host: 'github.com',
        private: true,
        sourceControlProvider: 'github',
      },
      {
        fullName: 'group/web',
        host: 'gitlab.com',
        private: false,
        sourceControlProvider: 'gitlab',
      },
    ];

    await expect(
      workspaceUsesOnlySourceControlProvider(
        dbOrTx,
        {
          type: 'repository_set',
          repositories: ['octo/api', 'group/web'],
        },
        'github',
      ),
    ).resolves.toBe(false);
  });
});
