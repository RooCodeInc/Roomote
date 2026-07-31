import { getDeploymentGitHubRoomoteMentionEnabled } from '@roomote/db/server';

import {
  isGitHubRoomoteMentionEnabled,
  setGitHubRoomoteMentionSettingCache,
} from './mention-settings';

export async function resolveGitHubRoomoteMentionEnabled(): Promise<boolean> {
  try {
    const value = await getDeploymentGitHubRoomoteMentionEnabled();
    setGitHubRoomoteMentionSettingCache({ value });
  } catch (error) {
    console.warn(
      `[resolveGitHubRoomoteMentionEnabled] falling back to the last known setting: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  return isGitHubRoomoteMentionEnabled();
}
