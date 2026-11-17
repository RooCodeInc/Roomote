const mocks = vi.hoisted(() => ({
  findSettings: vi.fn(),
  getInstanceAnalyticsId: vi.fn(),
  isAnonymousAnalyticsEnabledFromMetadata: vi.fn(),
}));

vi.mock('@roomote/env', () => ({
  Env: {
    APP_ENV: 'production',
    RELEASE_VERSION: 'v1.2.3',
    ROOMOTE_FORCE_TELEMETRY: undefined,
    R_PING_BASE_URL: 'https://ping.roomote.dev',
    R_CLOUD_ENABLED: 'false',
  },
  isRoomoteCloudEnabled: () => false,
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      deploymentSettings: { findFirst: mocks.findSettings },
    },
  },
  deploymentSettings: { id: 'id' },
  eq: vi.fn(),
  getInstanceAnalyticsId: mocks.getInstanceAnalyticsId,
  getUserAnalyticsId: vi.fn(),
  taskRuns: {},
}));

vi.mock('@roomote/feature-flags', () => ({
  isAnonymousAnalyticsEnabledFromMetadata:
    mocks.isAnonymousAnalyticsEnabledFromMetadata,
}));

import { sendInstanceReport } from '../server';

describe('sendInstanceReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findSettings.mockResolvedValue({ metadata: {} });
    mocks.getInstanceAnalyticsId.mockResolvedValue('instance-123');
    mocks.isAnonymousAnalyticsEnabledFromMetadata.mockReturnValue(false);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200 }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not send a report when analytics is disabled', async () => {
    await expect(sendInstanceReport({ users: { total: 17 } })).resolves.toBe(
      false,
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});
