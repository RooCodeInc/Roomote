import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockFindFirst } = vi.hoisted(() => ({
  mockFindFirst: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  and: (...args: unknown[]) => args,
  db: {
    query: {
      repositories: {
        findFirst: mockFindFirst,
      },
      githubInstallations: {
        findFirst: vi.fn(),
      },
      slackInstallations: {
        findFirst: vi.fn(),
      },
      mcpConnections: {
        findFirst: vi.fn(),
      },
    },
  },
  eq: (...args: unknown[]) => args,
  githubInstallations: {},
  inArray: (...args: unknown[]) => args,
  isNull: (...args: unknown[]) => args,
  mcpConnections: {},
  repositories: {
    isActive: 'isActive',
    sourceControlProvider: 'sourceControlProvider',
  },
  slackInstallations: {},
}));

import {
  hasActiveIssueTriageRepository,
  hasActiveRepository,
} from '../automation-requirements';

describe('automation repository requirements', () => {
  beforeEach(() => {
    mockFindFirst.mockReset();
  });

  it('hasActiveRepository accepts any active repository provider', async () => {
    mockFindFirst.mockResolvedValue({ id: 'ado-repo' });
    await expect(hasActiveRepository()).resolves.toBe(true);
  });

  it('hasActiveIssueTriageRepository requires an active GH/GL/Gitea repo', async () => {
    mockFindFirst.mockResolvedValueOnce(null);
    await expect(hasActiveIssueTriageRepository()).resolves.toBe(false);

    mockFindFirst.mockResolvedValueOnce({ id: 'gl-repo' });
    await expect(hasActiveIssueTriageRepository()).resolves.toBe(true);
  });
});
