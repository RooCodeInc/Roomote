// pnpm --filter @roomote/github test src/__tests__/resolve-mention-settings.test.ts

const { mockGetSetting } = vi.hoisted(() => ({
  mockGetSetting: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  getDeploymentGitHubRoomoteMentionEnabled: mockGetSetting,
}));

describe('resolveGitHubRoomoteMentionEnabled', () => {
  beforeEach(() => {
    vi.resetModules();
    mockGetSetting.mockReset();
  });

  it('refreshes the deployment setting on every call', async () => {
    mockGetSetting.mockResolvedValue(false);

    const { resolveGitHubRoomoteMentionEnabled } =
      await import('../resolve-mention-settings');

    await expect(resolveGitHubRoomoteMentionEnabled()).resolves.toBe(false);
    await expect(resolveGitHubRoomoteMentionEnabled()).resolves.toBe(false);
    expect(mockGetSetting).toHaveBeenCalledTimes(2);
  });

  it('defaults to enabled when resolution fails cold', async () => {
    mockGetSetting.mockRejectedValueOnce(new Error('database unavailable'));

    const { resolveGitHubRoomoteMentionEnabled } =
      await import('../resolve-mention-settings');

    await expect(resolveGitHubRoomoteMentionEnabled()).resolves.toBe(true);
  });

  it('keeps the last known value when refresh fails', async () => {
    mockGetSetting.mockResolvedValueOnce(false);

    const { resolveGitHubRoomoteMentionEnabled } =
      await import('../resolve-mention-settings');

    await expect(resolveGitHubRoomoteMentionEnabled()).resolves.toBe(false);
    mockGetSetting.mockRejectedValueOnce(new Error('database unavailable'));

    await expect(resolveGitHubRoomoteMentionEnabled()).resolves.toBe(false);
  });
});
