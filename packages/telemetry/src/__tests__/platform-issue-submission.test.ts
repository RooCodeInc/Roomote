const mocks = vi.hoisted(() => ({
  getInstanceAnalyticsId: vi.fn(),
}));

vi.mock('@roomote/env', () => ({
  Env: {
    APP_ENV: 'production',
    RELEASE_VERSION: 'v1.2.3',
    ROOMOTE_FORCE_TELEMETRY: undefined,
    R_PING_BASE_URL: 'https://ping.roomote.dev',
  },
  isRoomoteCloudEnabled: () => false,
}));

vi.mock('@roomote/db/server', () => ({
  db: { query: { deploymentSettings: { findFirst: vi.fn() } } },
  deploymentSettings: { id: 'id' },
  eq: vi.fn(),
  getInstanceAnalyticsId: mocks.getInstanceAnalyticsId,
  getUserAnalyticsId: vi.fn(),
  taskRuns: {},
}));

vi.mock('@roomote/feature-flags', () => ({
  isAnonymousAnalyticsEnabledFromMetadata: vi.fn(),
}));

import { submitPlatformIssueToPing } from '../server';

describe('submitPlatformIssueToPing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getInstanceAnalyticsId.mockResolvedValue('instance-123');
  });

  afterEach(() => vi.unstubAllGlobals());

  it('sends the bounded report contract only after the caller invokes it', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      submitPlatformIssueToPing({
        reportId: '5f55b5ee-7099-4ff2-b995-f39feb9c8eb0',
        report: {
          title: 'Worker cannot start',
          summary: 'The configured worker exits before claiming the task.',
          taskUrl: 'https://app.example.com/task/task-1',
        },
      }),
    ).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://ping.roomote.dev/v1/platform-issues');
    expect(JSON.parse(String(init?.body))).toMatchObject({
      reportId: '5f55b5ee-7099-4ff2-b995-f39feb9c8eb0',
      instanceId: 'instance-123',
      appVersion: 'v1.2.3',
      submittedAt: expect.any(String),
      report: {
        title: 'Worker cannot start',
        summary: 'The configured worker exits before claiming the task.',
        taskUrl: 'https://app.example.com/task/task-1',
      },
    });
  });

  it.each([
    ['a non-success response', { ok: false, status: 503 }],
    ['a network failure', new TypeError('network unavailable')],
  ])('returns false for %s', async (_case, outcome) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubGlobal(
      'fetch',
      outcome instanceof Error
        ? vi.fn().mockRejectedValue(outcome)
        : vi.fn().mockResolvedValue(outcome),
    );

    await expect(
      submitPlatformIssueToPing({
        reportId: '5f55b5ee-7099-4ff2-b995-f39feb9c8eb0',
        report: {
          title: 'Worker cannot start',
          summary: 'Details',
          taskUrl: 'https://app.example.com/task/task-1',
        },
      }),
    ).resolves.toBe(false);
    warn.mockRestore();
  });
});
