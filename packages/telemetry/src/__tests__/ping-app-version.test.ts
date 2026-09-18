const mocks = vi.hoisted(() => ({
  findSettings: vi.fn(),
  getInstanceAnalyticsId: vi.fn(),
  isAnonymousAnalyticsEnabledFromMetadata: vi.fn(),
  releaseVersion: undefined as string | undefined,
}));

vi.mock('@roomote/env', () => ({
  Env: {
    APP_ENV: 'production',
    get RELEASE_VERSION() {
      return mocks.releaseVersion;
    },
    ROOMOTE_FORCE_TELEMETRY: 'true',
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

import {
  captureInstanceEvent,
  checkLatestVersion,
  flushTelemetry,
  sendInstanceReport,
} from '../server';

describe('Ping appVersion payloads', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.VERCEL_GIT_COMMIT_SHA;
    delete process.env.GITHUB_SHA;
    mocks.findSettings.mockResolvedValue({ metadata: {} });
    mocks.getInstanceAnalyticsId.mockResolvedValue('instance-123');
    mocks.isAnonymousAnalyticsEnabledFromMetadata.mockReturnValue(true);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ latestVersion: 'v9.9.9' }),
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.VERCEL_GIT_COMMIT_SHA;
    delete process.env.GITHUB_SHA;
  });

  it.each([
    {
      name: 'missing',
      releaseVersion: undefined,
      expected: 'unknown',
    },
    { name: 'empty', releaseVersion: '   ', expected: 'unknown' },
    {
      name: 'present',
      releaseVersion: ' v1.2.3 ',
      expected: 'v1.2.3',
    },
    {
      name: 'missing with a Vercel commit',
      releaseVersion: undefined,
      vercelGitCommitSha: ' vercel-sha ',
      expected: 'vercel-sha',
    },
    {
      name: 'empty with a GitHub commit',
      releaseVersion: '   ',
      githubSha: ' github-sha ',
      expected: 'github-sha',
    },
  ])(
    'sends a non-empty appVersion when RELEASE_VERSION is $name',
    async ({ releaseVersion, vercelGitCommitSha, githubSha, expected }) => {
      mocks.releaseVersion = releaseVersion;
      if (vercelGitCommitSha) {
        process.env.VERCEL_GIT_COMMIT_SHA = vercelGitCommitSha;
      }
      if (githubSha) {
        process.env.GITHUB_SHA = githubSha;
      }

      await captureInstanceEvent('test_event');
      await flushTelemetry();
      await checkLatestVersion();
      await sendInstanceReport({ users: { total: 1 } });

      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(3);
      expect(
        vi.mocked(fetch).mock.calls.map(([url, init]) => ({
          path: new URL(String(url)).pathname,
          appVersion: JSON.parse(String(init?.body)).appVersion,
        })),
      ).toEqual([
        { path: '/v1/events', appVersion: expected },
        { path: '/v1/version-check', appVersion: expected },
        { path: '/v1/instance-report', appVersion: expected },
      ]);
    },
  );
});
