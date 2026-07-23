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
        fullName: 'roomote/Test ADO/Test ADO',
        sourceControlProvider: 'ado',
        host: 'dev.azure.com',
      },
      {
        fullName: 'roomote/stoodio-bitbucket',
        sourceControlProvider: 'bitbucket',
        host: 'bitbucket.org',
      },
      {
        fullName: 'acme/api',
        sourceControlProvider: 'github',
        host: 'github.com',
      },
    ]);

    const partitions = await partitionActiveRepositoriesByProvider([
      'roomote/Test ADO/Test ADO',
      'roomote/stoodio-bitbucket',
      'acme/api',
    ]);

    // Provider enum order: github, gitlab, gitea, ado, bitbucket.
    expect(partitions).toEqual([
      {
        provider: 'github',
        host: 'github.com',
        repositoryFullNames: ['acme/api'],
      },
      {
        provider: 'ado',
        host: 'dev.azure.com',
        repositoryFullNames: ['roomote/Test ADO/Test ADO'],
      },
      {
        provider: 'bitbucket',
        host: 'bitbucket.org',
        repositoryFullNames: ['roomote/stoodio-bitbucket'],
      },
    ]);
  });

  it('splits same-provider repositories on different hosts into separate partitions', async () => {
    selectResolving([
      {
        fullName: 'acme/api',
        sourceControlProvider: 'gitlab',
        host: 'gitlab.acme.dev',
      },
      {
        fullName: 'acme/api',
        sourceControlProvider: 'gitlab',
        host: 'gitlab.com',
      },
      {
        fullName: 'acme/web',
        sourceControlProvider: 'gitlab',
        host: 'gitlab.com',
      },
    ]);

    const partitions = await partitionActiveRepositoriesByProvider([
      'acme/api',
      'acme/web',
    ]);

    expect(partitions).toEqual([
      {
        provider: 'gitlab',
        host: 'gitlab.acme.dev',
        repositoryFullNames: ['acme/api'],
      },
      {
        provider: 'gitlab',
        host: 'gitlab.com',
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
