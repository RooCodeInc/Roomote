import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRepositoriesFindMany } = vi.hoisted(() => ({
  mockRepositoriesFindMany: vi.fn(),
}));

vi.mock('@roomote/gitlab', () => ({
  isGitLabOAuthAccessToken: () => false,
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      repositories: {
        findMany: (...args: unknown[]) => mockRepositoriesFindMany(...args),
      },
      environments: {
        findFirst: vi.fn(),
      },
    },
  },
  repositories: {
    sourceControlProvider: 'repositories.sourceControlProvider',
    fullName: 'repositories.fullName',
    isActive: 'repositories.isActive',
  },
  environments: {
    id: 'environments.id',
  },
  and: vi.fn((...conditions: unknown[]) => ({ type: 'and', conditions })),
  eq: vi.fn((left: unknown, right: unknown) => ({ type: 'eq', left, right })),
}));

import {
  resolveRepositoryRow,
  type RepositoryRow,
} from '../source-control-pull-request-shared';

function repositoryRow(params: {
  id: string;
  host: string | null;
}): RepositoryRow {
  return {
    id: params.id,
    sourceControlProvider: 'gitlab',
    host: params.host,
    installationId: null,
    externalRepoId: `external-${params.id}`,
    fullName: 'acme/backend',
    htmlUrl: `https://${params.host ?? 'gitlab.com'}/acme/backend`,
  };
}

describe('resolveRepositoryRow host scoping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('prefers the exact host match over a legacy null-host row', async () => {
    const exactRow = repositoryRow({
      id: 'repo-exact',
      host: 'gitlab.example.com',
    });
    mockRepositoriesFindMany.mockResolvedValue([
      repositoryRow({ id: 'repo-legacy', host: null }),
      exactRow,
      repositoryRow({ id: 'repo-other-host', host: 'gitlab.other.example' }),
    ]);

    await expect(
      resolveRepositoryRow({
        provider: 'gitlab',
        repositoryFullName: 'acme/backend',
        host: 'gitlab.example.com',
      }),
    ).resolves.toEqual(exactRow);
  });

  it('falls back to a legacy null-host row when no row matches the host exactly', async () => {
    const legacyRow = repositoryRow({ id: 'repo-legacy', host: null });
    mockRepositoriesFindMany.mockResolvedValue([
      repositoryRow({ id: 'repo-other-host', host: 'gitlab.other.example' }),
      legacyRow,
    ]);

    await expect(
      resolveRepositoryRow({
        provider: 'gitlab',
        repositoryFullName: 'acme/backend',
        host: 'gitlab.example.com',
      }),
    ).resolves.toEqual(legacyRow);
  });

  it('reports the host in the not-found error when no row qualifies for it', async () => {
    mockRepositoriesFindMany.mockResolvedValue([
      repositoryRow({ id: 'repo-other-host', host: 'gitlab.other.example' }),
    ]);

    await expect(
      resolveRepositoryRow({
        provider: 'gitlab',
        repositoryFullName: 'acme/backend',
        host: 'gitlab.example.com',
      }),
    ).rejects.toThrow(
      'GitLab repository not found or inactive on gitlab.example.com: acme/backend',
    );
  });

  it('rejects multiple candidates within the chosen host tier', async () => {
    mockRepositoriesFindMany.mockResolvedValue([
      repositoryRow({ id: 'repo-legacy-1', host: null }),
      repositoryRow({ id: 'repo-legacy-2', host: null }),
    ]);

    await expect(
      resolveRepositoryRow({
        provider: 'gitlab',
        repositoryFullName: 'acme/backend',
        host: 'gitlab.example.com',
      }),
    ).rejects.toThrow(
      'GitLab repository acme/backend matches more than one active repository on gitlab.example.com.',
    );
  });

  it('rejects a multi-host identity when the caller provides no host', async () => {
    mockRepositoriesFindMany.mockResolvedValue([
      repositoryRow({ id: 'repo-b', host: 'gitlab.host-b.example' }),
      repositoryRow({ id: 'repo-a', host: 'gitlab.host-a.example' }),
      repositoryRow({ id: 'repo-legacy', host: null }),
    ]);

    await expect(
      resolveRepositoryRow({
        provider: 'gitlab',
        repositoryFullName: 'acme/backend',
      }),
    ).rejects.toThrow(
      'GitLab repository acme/backend is linked from multiple hosts ' +
        '(gitlab.host-a.example, gitlab.host-b.example, unknown host); ' +
        'the task payload must carry sourceControlHost to disambiguate.',
    );
  });

  it('returns the single matching row unchanged when the caller provides no host', async () => {
    const row = repositoryRow({ id: 'repo-only', host: 'gitlab.example.com' });
    mockRepositoriesFindMany.mockResolvedValue([row]);

    await expect(
      resolveRepositoryRow({
        provider: 'gitlab',
        repositoryFullName: 'acme/backend',
      }),
    ).resolves.toEqual(row);
  });

  it('keeps the host-free not-found error message unchanged', async () => {
    mockRepositoriesFindMany.mockResolvedValue([]);

    await expect(
      resolveRepositoryRow({
        provider: 'gitlab',
        repositoryFullName: 'acme/backend',
      }),
    ).rejects.toThrow('GitLab repository not found or inactive: acme/backend');
  });
});
