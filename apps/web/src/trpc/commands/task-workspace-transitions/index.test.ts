import { describe, expect, it } from 'vitest';

import type { WorkspaceGitManifest } from '@roomote/types';

import { getGitBlockReason } from './git-gate';

function manifest(
  overrides: Partial<WorkspaceGitManifest['repositories'][number]> = {},
): WorkspaceGitManifest {
  return {
    inspectedAt: new Date().toISOString(),
    repositories: [
      {
        repository: 'acme/app',
        branch: 'main',
        headSha: 'abc123',
        upstream: 'origin/main',
        ahead: 0,
        behind: 0,
        dirtyPaths: [],
        ...overrides,
      },
    ],
  };
}

describe('getGitBlockReason', () => {
  it('allows a clean branch whose commits are pushed', () => {
    expect(getGitBlockReason(manifest())).toBeNull();
  });

  it('blocks dirty worktrees', () => {
    expect(
      getGitBlockReason(manifest({ dirtyPaths: ['src/app.ts'] })),
    ).toContain('Commit or discard');
  });

  it('blocks unpushed and untracked branches', () => {
    expect(getGitBlockReason(manifest({ ahead: 1 }))).toContain('Push every');
    expect(getGitBlockReason(manifest({ upstream: null }))).toContain(
      'Push every',
    );
  });
});
