import { describe, expect, it } from 'vitest';

import {
  resolvedWorkspaceSpecSchema,
  workspaceGitManifestSchema,
} from '../task-workspace-transitions';

describe('workspace transition schemas', () => {
  it('validates a bounded immutable environment snapshot', () => {
    expect(
      resolvedWorkspaceSpecSchema.safeParse({
        version: 1,
        environmentId: '62b763be-2e56-4e51-a71d-941370461de9',
        environmentConfigVersionId: 'cf222dd3-0a32-41d6-a06e-466e10d21c20',
        environmentName: 'App workspace',
        config: {
          name: 'App workspace',
          repositories: [{ repository: 'acme/app' }],
        },
      }).success,
    ).toBe(true);
  });

  it('rejects negative Git divergence counts', () => {
    const parsed = workspaceGitManifestSchema.safeParse({
      inspectedAt: new Date().toISOString(),
      repositories: [
        {
          repository: 'acme/app',
          branch: 'main',
          headSha: 'abc',
          upstream: 'origin/main',
          ahead: -1,
          behind: 0,
          dirtyPaths: [],
        },
      ],
    });
    expect(parsed.success).toBe(false);
  });
});
