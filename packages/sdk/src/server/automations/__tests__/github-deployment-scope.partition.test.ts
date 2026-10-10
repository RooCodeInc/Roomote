const { mockSelect } = vi.hoisted(() => ({
  mockSelect: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  db: { select: mockSelect },
  and: vi.fn((...args: unknown[]) => args),
  eq: vi.fn((...args: unknown[]) => args),
  inArray: vi.fn((...args: unknown[]) => args),
  isNull: vi.fn((...args: unknown[]) => args),
  sql: vi.fn(),
  repositories: {
    fullName: 'fullName',
    sourceControlProvider: 'sourceControlProvider',
    host: 'host',
    isActive: 'isActive',
    id: 'id',
    externalRepoId: 'externalRepoId',
    defaultBranch: 'defaultBranch',
  },
  environmentRepositoryMappings: {},
  environments: {},
  githubInstallations: {},
}));

import { partitionActiveRepositoriesByProvider } from '../github-deployment-scope';

type Row = {
  id: string;
  fullName: string;
  sourceControlProvider: string;
  host: string | null;
};

function selectResolving(rows: Row[]) {
  const chain = {
    from: () => chain,
    where: () => chain,
    orderBy: () => Promise.resolve(rows),
  };
  mockSelect.mockReturnValue(chain);
}

describe('partitionActiveRepositoriesByProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns one partition per (provider, host) in provider enum order', async () => {
    selectResolving([
      {
        id: 'repo-ado',
        fullName: 'roomote/Test ADO/Test ADO',
        sourceControlProvider: 'ado',
        host: 'dev.azure.com',
      },
      {
        id: 'repo-bitbucket',
        fullName: 'roomote/stoodio-bitbucket',
        sourceControlProvider: 'bitbucket',
        host: 'bitbucket.org',
      },
      {
        id: 'repo-github',
        fullName: 'acme/api',
        sourceControlProvider: 'github',
        host: 'github.com',
      },
    ]);

    const partitions = await partitionActiveRepositoriesByProvider([
      'repo-ado',
      'repo-bitbucket',
      'repo-github',
    ]);

    // Provider enum order: github, gitlab, gitea, ado, bitbucket.
    expect(partitions).toEqual([
      {
        provider: 'github',
        host: 'github.com',
        repositoryIds: ['repo-github'],
        repositoryFullNames: ['acme/api'],
      },
      {
        provider: 'ado',
        host: 'dev.azure.com',
        repositoryIds: ['repo-ado'],
        repositoryFullNames: ['roomote/Test ADO/Test ADO'],
      },
      {
        provider: 'bitbucket',
        host: 'bitbucket.org',
        repositoryIds: ['repo-bitbucket'],
        repositoryFullNames: ['roomote/stoodio-bitbucket'],
      },
    ]);
  });

  it('splits same-provider repositories on different hosts into separate partitions', async () => {
    selectResolving([
      {
        id: 'repo-acme-api',
        fullName: 'acme/api',
        sourceControlProvider: 'gitlab',
        host: 'gitlab.acme.dev',
      },
      {
        id: 'repo-gitlab-api',
        fullName: 'acme/api',
        sourceControlProvider: 'gitlab',
        host: 'gitlab.com',
      },
      {
        id: 'repo-gitlab-web',
        fullName: 'acme/web',
        sourceControlProvider: 'gitlab',
        host: 'gitlab.com',
      },
    ]);

    const partitions = await partitionActiveRepositoriesByProvider([
      'repo-acme-api',
      'repo-gitlab-api',
      'repo-gitlab-web',
    ]);

    expect(partitions).toEqual([
      {
        provider: 'gitlab',
        host: 'gitlab.acme.dev',
        repositoryIds: ['repo-acme-api'],
        repositoryFullNames: ['acme/api'],
      },
      {
        provider: 'gitlab',
        host: 'gitlab.com',
        repositoryIds: ['repo-gitlab-api', 'repo-gitlab-web'],
        repositoryFullNames: ['acme/api', 'acme/web'],
      },
    ]);
  });

  it('returns no partitions for an empty scope without querying', async () => {
    const partitions = await partitionActiveRepositoriesByProvider([]);

    expect(partitions).toEqual([]);
    expect(mockSelect).not.toHaveBeenCalled();
  });
});
