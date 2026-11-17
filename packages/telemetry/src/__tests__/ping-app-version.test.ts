const mocks = vi.hoisted(() => ({
  getInstanceAnalyticsId: vi.fn(),
  releaseVersion: undefined as string | undefined,
  cloudEnabled: true,
}));

vi.mock('@roomote/env', () => ({
  Env: {
    APP_ENV: 'production',
    get RELEASE_VERSION() {
      return mocks.releaseVersion;
    },
    ROOMOTE_FORCE_TELEMETRY: 'true',
    R_PING_BASE_URL: 'https://ping.roomote.dev',
    R_CLOUD_ENABLED: 'true',
  },
  isRoomoteCloudEnabled: () => mocks.cloudEnabled,
}));

vi.mock('@roomote/db/server', () => ({
  db: { query: {} },
  eq: vi.fn(),
  getInstanceAnalyticsId: mocks.getInstanceAnalyticsId,
  getUserAnalyticsId: vi.fn(),
  taskRuns: {},
}));

import {
  captureInstanceEvent,
  checkLatestVersion,
  flushTelemetry,
  sendInstanceReport,
} from '../server';

describe('Ping payloads', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.cloudEnabled = true;
    delete process.env.VERCEL_GIT_COMMIT_SHA;
    delete process.env.GITHUB_SHA;
    mocks.getInstanceAnalyticsId.mockResolvedValue('instance-123');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ tag_name: 'v9.9.9' }),
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.VERCEL_GIT_COMMIT_SHA;
    delete process.env.GITHUB_SHA;
  });

  it.each([
    { name: 'missing', releaseVersion: undefined, expected: 'unknown' },
    { name: 'empty', releaseVersion: '   ', expected: 'unknown' },
    { name: 'present', releaseVersion: ' v1.2.3 ', expected: 'v1.2.3' },
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
      await sendInstanceReport({ users: { total: 1 } });

      expect(
        vi.mocked(fetch).mock.calls.map(([url, init]) => ({
          path: new URL(String(url)).pathname,
          appVersion: JSON.parse(String(init?.body)).appVersion,
        })),
      ).toEqual([
        { path: '/v1/events', appVersion: expected },
        { path: '/v1/instance-report', appVersion: expected },
      ]);
    },
  );

  it('sends no analytics from a self-hosted deployment', async () => {
    mocks.cloudEnabled = false;
    mocks.releaseVersion = 'v1.2.3';

    await captureInstanceEvent('test_event');
    await flushTelemetry();
    await expect(sendInstanceReport({ users: { total: 1 } })).resolves.toBe(
      false,
    );

    expect(fetch).not.toHaveBeenCalled();
  });

  it('reads the latest version from GitHub Releases, not Ping', async () => {
    mocks.cloudEnabled = false;
    mocks.releaseVersion = 'v1.2.3';

    await expect(checkLatestVersion()).resolves.toEqual({
      latestVersion: 'v9.9.9',
    });

    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = vi.mocked(fetch).mock.calls[0] ?? [];
    expect(String(url)).toBe(
      'https://api.github.com/repos/RooCodeInc/Roomote/releases/latest',
    );
    expect(init?.body).toBeUndefined();
  });
});
