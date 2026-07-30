export type GitHubRoomoteMentionSettingCache = {
  value: boolean;
};

let roomoteMentionSettingCache: GitHubRoomoteMentionSettingCache | null = null;

export function getGitHubRoomoteMentionSettingCache(): GitHubRoomoteMentionSettingCache | null {
  return roomoteMentionSettingCache;
}

export function setGitHubRoomoteMentionSettingCache(
  cache: GitHubRoomoteMentionSettingCache | null,
): void {
  roomoteMentionSettingCache = cache;
}

export function isGitHubRoomoteMentionEnabled(): boolean {
  return roomoteMentionSettingCache?.value ?? true;
}
