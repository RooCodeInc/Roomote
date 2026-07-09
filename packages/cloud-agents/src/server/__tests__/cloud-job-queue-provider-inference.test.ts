// pnpm --filter @roomote/cloud-agents test src/server/__tests__/cloud-job-queue-provider-inference.test.ts
const { mockWhere } = vi.hoisted(() => ({
  mockWhere: vi.fn(),
}));

vi.mock('@roomote/db/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@roomote/db/server')>();

  return {
    ...actual,
    db: {
      ...actual.db,
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          innerJoin: vi.fn(() => ({ where: mockWhere })),
          where: mockWhere,
        })),
      })),
    },
  };
});

import { inferWorkspaceSourceControlProvider } from '../cloud-job-queue';

describe('inferWorkspaceSourceControlProvider', () => {
  beforeEach(() => {
    mockWhere.mockReset();
  });

  it('infers the provider from an environment with a single-provider mapping', async () => {
    mockWhere.mockResolvedValue([{ provider: 'ado' }]);

    await expect(
      inferWorkspaceSourceControlProvider({
        type: 'environment',
        environmentId: 'env-1',
      }),
    ).resolves.toBe('ado');
  });

  it('infers the provider from a single repository workspace', async () => {
    mockWhere.mockResolvedValue([{ provider: 'gitlab' }]);

    await expect(
      inferWorkspaceSourceControlProvider({
        type: 'repository',
        repo: 'group/subgroup/repo',
      }),
    ).resolves.toBe('gitlab');
  });

  it('infers the provider from a repository set sharing one provider', async () => {
    mockWhere.mockResolvedValue([{ provider: 'ado' }, { provider: 'ado' }]);

    await expect(
      inferWorkspaceSourceControlProvider({
        type: 'repository_set',
        repositories: ['acme/Platform/backend', 'acme/Platform/frontend'],
      }),
    ).resolves.toBe('ado');
  });

  it('returns undefined when the workspace spans multiple providers', async () => {
    mockWhere.mockResolvedValue([{ provider: 'ado' }, { provider: 'github' }]);

    await expect(
      inferWorkspaceSourceControlProvider({ type: 'all_repositories' }),
    ).resolves.toBeUndefined();
  });

  it('returns undefined when no repository rows match', async () => {
    mockWhere.mockResolvedValue([]);

    await expect(
      inferWorkspaceSourceControlProvider({
        type: 'repository',
        repo: 'owner/unknown',
      }),
    ).resolves.toBeUndefined();
  });
});
