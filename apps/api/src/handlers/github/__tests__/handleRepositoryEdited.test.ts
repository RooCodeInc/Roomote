import { describe, expect, it, vi, beforeEach } from 'vitest';

const { mockSet, mockWhere, mockReturning } = vi.hoisted(() => ({
  mockSet: vi.fn(),
  mockWhere: vi.fn(),
  mockReturning: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    update: () => ({
      set: (values: unknown) => {
        mockSet(values);
        return {
          where: (condition: unknown) => {
            mockWhere(condition);
            return { returning: () => mockReturning() };
          },
        };
      },
    }),
  },
  repositories: {
    sourceControlProvider: 'source_control_provider',
    githubRepoId: 'github_repo_id',
    defaultBranch: 'default_branch',
  },
  and: (...conditions: unknown[]) => ({ and: conditions }),
  eq: (column: unknown, value: unknown) => ({ eq: [column, value] }),
  ne: (column: unknown, value: unknown) => ({ ne: [column, value] }),
}));

import { handleRepositoryEdited } from '../handleRepositoryEdited';

function makePayload(
  overrides: Partial<{
    changes: { default_branch?: { from?: string | null } | null } | null;
  }> = {},
) {
  return {
    action: 'edited',
    changes: { default_branch: { from: 'main' } },
    repository: {
      id: 1234,
      full_name: 'acme/backend',
      default_branch: 'develop',
    },
    installation: { id: 42 },
    ...overrides,
  };
}

describe('handleRepositoryEdited', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReturning.mockResolvedValue([{ id: 'repo-1' }]);
  });

  it('updates stored default branches when the default branch changed', async () => {
    const response = await handleRepositoryEdited(makePayload());

    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({ defaultBranch: 'develop' }),
    );
    expect(mockWhere).toHaveBeenCalledWith({
      and: [
        { eq: ['source_control_provider', 'github'] },
        { eq: ['github_repo_id', 1234] },
        { ne: ['default_branch', 'develop'] },
      ],
    });
    expect(response).toEqual({
      status: 'ok',
      message: 'Updated default branch for acme/backend to develop',
      metadata: { updatedRepositoryCount: 1 },
    });
  });

  it('ignores edits that do not change the default branch', async () => {
    const response = await handleRepositoryEdited(
      makePayload({ changes: { default_branch: null } }),
    );

    expect(mockSet).not.toHaveBeenCalled();
    expect(response).toEqual({
      status: 'ok',
      message: 'Ignoring non-default-branch edit',
    });
  });

  it('ignores edits with no changes payload', async () => {
    const response = await handleRepositoryEdited(
      makePayload({ changes: null }),
    );

    expect(mockSet).not.toHaveBeenCalled();
    expect(response).toEqual({
      status: 'ok',
      message: 'Ignoring non-default-branch edit',
    });
  });

  it('reports zero updated rows when no stored repository matched', async () => {
    mockReturning.mockResolvedValue([]);

    const response = await handleRepositoryEdited(makePayload());

    expect(response.metadata).toEqual({ updatedRepositoryCount: 0 });
  });
});
