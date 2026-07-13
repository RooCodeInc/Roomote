const { mockDeploymentSettingsFindFirst } = vi.hoisted(() => ({
  mockDeploymentSettingsFindFirst: vi.fn(),
}));

vi.mock('../db', () => ({
  db: {
    query: {
      deploymentSettings: {
        findFirst: (...args: unknown[]) =>
          mockDeploymentSettingsFindFirst(...args),
      },
    },
  },
}));

vi.mock('../schema', () => ({
  deploymentSettings: { id: 'deploymentSettings.id' },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
}));

import {
  getConfiguredRouterDebugSlackChannelId,
  getRouterDebugSettings,
  normalizeRouterDebugSlackChannelId,
} from './router-debug-settings';

describe('router debug settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('normalizes Slack channel IDs', () => {
    expect(normalizeRouterDebugSlackChannelId(' c0am0lxgklh ')).toBe(
      'C0AM0LXGKLH',
    );
    expect(normalizeRouterDebugSlackChannelId('not-a-channel')).toBeNull();
  });

  it('prefers the deployment channel over the env fallback', async () => {
    mockDeploymentSettingsFindFirst.mockResolvedValue({
      routerDebugSlackChannelId: 'CDEPLOY123',
    });

    await expect(
      getRouterDebugSettings({
        runtimeEnv: {
          R_ROUTER_DEBUG_CHANNEL_ID: 'CENV123456',
        },
      }),
    ).resolves.toMatchObject({
      routerDebugSlackChannelId: 'CDEPLOY123',
      envFallbackSlackChannelId: 'CENV123456',
      effectiveRouterDebugSlackChannelId: 'CDEPLOY123',
      source: 'deployment',
    });
  });

  it('falls back to the env channel when no deployment channel is set', async () => {
    mockDeploymentSettingsFindFirst.mockResolvedValue({
      routerDebugSlackChannelId: null,
    });

    await expect(
      getConfiguredRouterDebugSlackChannelId({
        runtimeEnv: {
          R_ROUTER_DEBUG_CHANNEL_ID: ' cenv123456 ',
        },
      }),
    ).resolves.toBe('CENV123456');
  });
});
