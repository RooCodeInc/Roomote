import type { DatabaseOrTransaction } from '../db';
import { getDeploymentGitHubRoomoteMentionEnabled } from './github-mention-settings';

function executorWithMetadata(metadata: Record<string, unknown> | null) {
  return {
    query: {
      deploymentSettings: {
        findFirst: vi.fn().mockResolvedValue(metadata ? { metadata } : null),
      },
    },
  } as unknown as DatabaseOrTransaction;
}

describe('getDeploymentGitHubRoomoteMentionEnabled', () => {
  it('defaults to enabled when the setting is absent', async () => {
    await expect(
      getDeploymentGitHubRoomoteMentionEnabled({
        executor: executorWithMetadata(null),
      }),
    ).resolves.toBe(true);
  });

  it('returns a persisted opt-out', async () => {
    await expect(
      getDeploymentGitHubRoomoteMentionEnabled({
        executor: executorWithMetadata({
          github_roomote_mention_enabled: false,
        }),
      }),
    ).resolves.toBe(false);
  });
});
