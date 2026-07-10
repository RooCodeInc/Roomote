// pnpm --filter @roomote/db exec vitest run src/lib/__tests__/source-control-provider.test.ts
import type { DatabaseOrTransaction } from '../../db';
import { resolveWorkspaceSourceControlProvider } from '../source-control-provider';

const mockWhere = vi.fn();

const dbOrTx = {
  select: vi.fn(() => ({
    from: vi.fn(() => ({
      innerJoin: vi.fn(() => ({ where: mockWhere })),
      where: mockWhere,
    })),
  })),
} as unknown as DatabaseOrTransaction;

describe('resolveWorkspaceSourceControlProvider', () => {
  beforeEach(() => {
    mockWhere.mockReset();
  });

  it('resolves the provider from an environment with a single-provider mapping', async () => {
    mockWhere.mockResolvedValue([{ sourceControlProvider: 'ado' }]);

    await expect(
      resolveWorkspaceSourceControlProvider(dbOrTx, {
        type: 'environment',
        environmentId: 'env-1',
      }),
    ).resolves.toBe('ado');
  });

  it('resolves the provider from a single repository workspace', async () => {
    mockWhere.mockResolvedValue([{ sourceControlProvider: 'gitlab' }]);

    await expect(
      resolveWorkspaceSourceControlProvider(dbOrTx, {
        type: 'repository',
        repo: 'group/subgroup/repo',
      }),
    ).resolves.toBe('gitlab');
  });

  it('resolves the provider from a repository set sharing one provider', async () => {
    mockWhere.mockResolvedValue([
      { sourceControlProvider: 'ado' },
      { sourceControlProvider: 'ado' },
    ]);

    await expect(
      resolveWorkspaceSourceControlProvider(dbOrTx, {
        type: 'repository_set',
        repositories: ['acme/Platform/backend', 'acme/Platform/frontend'],
      }),
    ).resolves.toBe('ado');
  });

  it('returns undefined when the workspace spans multiple providers', async () => {
    mockWhere.mockResolvedValue([
      { sourceControlProvider: 'ado' },
      { sourceControlProvider: 'github' },
    ]);

    await expect(
      resolveWorkspaceSourceControlProvider(dbOrTx, {
        type: 'all_repositories',
      }),
    ).resolves.toBeUndefined();
  });

  it('returns undefined when no repository rows match', async () => {
    mockWhere.mockResolvedValue([]);

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
});
