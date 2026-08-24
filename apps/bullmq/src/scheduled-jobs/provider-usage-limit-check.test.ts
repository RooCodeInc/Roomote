import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findSlackInstallation: vi.fn(),
  desc: vi.fn((column: unknown) => ({ desc: column })),
}));

vi.mock('@roomote/db/server', async (importOriginal) => {
  const original = await importOriginal<typeof import('@roomote/db/server')>();
  return {
    ...original,
    db: {
      query: {
        slackInstallations: { findFirst: mocks.findSlackInstallation },
      },
    },
    desc: mocks.desc,
  };
});

import type { ProviderUsageLimitSnapshot } from '@roomote/db/server';

import {
  buildProviderUsageLimitWarningMessage,
  getActiveSlackBotToken,
  getProviderUsageLimitPeriodId,
  providerUsageLimitCheckJob,
} from './provider-usage-limit-check';

function createRedis() {
  const values = new Map<string, string>();
  return {
    values,
    set: vi.fn(
      async (
        key: string,
        value: string,
        _expiryMode: string,
        _ttl: number,
        _setMode: string,
      ) => {
        if (values.has(key)) return null;
        values.set(key, value);
        return 'OK';
      },
    ),
    del: vi.fn(async (key: string) => (values.delete(key) ? 1 : 0)),
  };
}

function snapshot(
  overrides: Partial<ProviderUsageLimitSnapshot> = {},
): ProviderUsageLimitSnapshot {
  return {
    providerId: 'openrouter',
    providerName: 'OpenRouter',
    credentialFingerprint: 'abc123def456',
    credentialLabel: 'Production (abc123def456)',
    windowLabel: 'Weekly limit',
    usedPercent: 95,
    used: 95,
    remaining: 5,
    limit: 100,
    currency: 'USD',
    resetCadence: 'weekly',
    ...overrides,
  };
}

function dependencies(params: {
  snapshots: () => ProviderUsageLimitSnapshot[];
  postMessage?: ReturnType<typeof vi.fn>;
  redis?: ReturnType<typeof createRedis>;
  now?: () => Date;
  channelId?: string | null;
}) {
  const redis = params.redis ?? createRedis();
  const postMessage = params.postMessage ?? vi.fn().mockResolvedValue('123.45');
  return {
    redis,
    postMessage,
    overrides: {
      getManagerSlackChannelId: vi
        .fn()
        .mockResolvedValue(
          params.channelId === undefined ? 'C-MANAGER' : params.channelId,
        ),
      getSlackBotToken: vi.fn().mockResolvedValue('xoxb-token'),
      getSnapshots: vi.fn(async () => params.snapshots()),
      getRedisClient: () => redis as never,
      createNotifier: () => ({ postMessage }) as never,
      now: params.now ?? (() => new Date('2026-08-19T12:00:00.000Z')),
    },
  };
}

describe('getProviderUsageLimitPeriodId', () => {
  it('uses the provider reset timestamp when available', () => {
    expect(
      getProviderUsageLimitPeriodId(
        snapshot({ resetsAt: '2026-08-24T00:00:00.000Z' }),
        new Date('2026-08-19T12:00:00.000Z'),
      ),
    ).toBe('until:2026-08-24T00:00:00.000Z');
  });

  it('derives OpenRouter weekly periods from Monday UTC', () => {
    expect(
      getProviderUsageLimitPeriodId(
        snapshot(),
        new Date('2026-08-19T12:00:00.000Z'),
      ),
    ).toBe('weekly:2026-08-17');
  });
});

describe('buildProviderUsageLimitWarningMessage', () => {
  it('includes severity, provider, key identifier, percent, and raw usage', () => {
    const message = buildProviderUsageLimitWarningMessage({
      snapshot: snapshot(),
      threshold: 90,
    });

    expect(message.text).toBe('High: OpenRouter usage is at 95%');
    expect(message.blocks[0]?.text).toContain(
      '**High: OpenRouter usage is at 95%**',
    );
    expect(message.blocks[0]?.text).toContain('Key: Production (abc123def456)');
    expect(message.blocks[0]?.text).toContain('Usage: $95.00 / $100.00');
    expect(message.blocks[0]?.text).toContain('Threshold crossed: 90%');
  });

  it('escalates exhausted limits to critical severity', () => {
    const message = buildProviderUsageLimitWarningMessage({
      snapshot: snapshot({ usedPercent: 100, used: 100, remaining: 0 }),
      threshold: 100,
    });

    expect(message.text).toBe('Critical: OpenRouter usage is at 100%');
    expect(message.blocks[0]?.text).toContain(':rotating_light: **Critical:');
  });
});

describe('providerUsageLimitCheckJob', () => {
  it('uses the most recently updated active Slack installation', async () => {
    const installations = [
      {
        botAccessToken: 'xoxb-older-workspace',
        updatedAt: new Date('2026-08-01T00:00:00.000Z'),
      },
      {
        botAccessToken: 'xoxb-newest-workspace',
        updatedAt: new Date('2026-08-20T00:00:00.000Z'),
      },
    ];
    mocks.findSlackInstallation.mockImplementationOnce(
      async ({ orderBy }: { orderBy?: unknown[] }) =>
        orderBy?.length ? installations[1] : installations[0],
    );

    await expect(getActiveSlackBotToken()).resolves.toBe(
      'xoxb-newest-workspace',
    );
    expect(mocks.findSlackInstallation).toHaveBeenCalledWith({
      where: expect.anything(),
      orderBy: [expect.objectContaining({ desc: expect.anything() })],
      columns: { botAccessToken: true },
    });
    expect(mocks.desc).toHaveBeenCalledTimes(1);
  });

  it('posts each newly crossed threshold only once in a limit period', async () => {
    const deps = dependencies({ snapshots: () => [snapshot()] });

    await providerUsageLimitCheckJob(deps.overrides);
    await providerUsageLimitCheckJob(deps.overrides);

    expect(deps.postMessage).toHaveBeenCalledTimes(2);
    expect(deps.postMessage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        channel: 'C-MANAGER',
        text: 'Warning: OpenRouter usage is at 95%',
      }),
    );
    expect(deps.postMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        text: 'High: OpenRouter usage is at 95%',
      }),
    );
  });

  it('notifies again when the provider limit period resets', async () => {
    let now = new Date('2026-08-19T12:00:00.000Z');
    const deps = dependencies({
      snapshots: () => [snapshot({ usedPercent: 85 })],
      now: () => now,
    });

    await providerUsageLimitCheckJob(deps.overrides);
    now = new Date('2026-08-26T12:00:00.000Z');
    await providerUsageLimitCheckJob(deps.overrides);

    expect(deps.postMessage).toHaveBeenCalledTimes(2);
  });

  it('re-arms rolling thresholds after usage drops below them', async () => {
    let usedPercent = 85;
    const deps = dependencies({
      snapshots: () => [
        snapshot({
          windowLabel: 'Rolling limit',
          resetCadence: undefined,
          usedPercent,
        }),
      ],
    });

    await providerUsageLimitCheckJob(deps.overrides);
    usedPercent = 70;
    await providerUsageLimitCheckJob(deps.overrides);
    usedPercent = 85;
    await providerUsageLimitCheckJob(deps.overrides);

    expect(deps.postMessage).toHaveBeenCalledTimes(2);
  });

  it('releases a claim when Slack delivery fails so the job can retry', async () => {
    const postMessage = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValue('123.45');
    const deps = dependencies({
      snapshots: () => [snapshot({ usedPercent: 85 })],
      postMessage,
    });

    await expect(providerUsageLimitCheckJob(deps.overrides)).rejects.toThrow(
      'Failed to post openrouter 80% warning',
    );
    await expect(
      providerUsageLimitCheckJob(deps.overrides),
    ).resolves.toBeUndefined();

    expect(postMessage).toHaveBeenCalledTimes(2);
  });

  it('releases a claim when Slack delivery throws so the job can retry', async () => {
    const postMessage = vi
      .fn()
      .mockRejectedValueOnce(new Error('Slack unavailable'))
      .mockResolvedValue('123.45');
    const deps = dependencies({
      snapshots: () => [snapshot({ usedPercent: 85 })],
      postMessage,
    });

    await expect(providerUsageLimitCheckJob(deps.overrides)).rejects.toThrow(
      'Slack unavailable',
    );
    await expect(
      providerUsageLimitCheckJob(deps.overrides),
    ).resolves.toBeUndefined();

    expect(postMessage).toHaveBeenCalledTimes(2);
  });

  it('does not query providers when the manager channel is not configured', async () => {
    const deps = dependencies({
      snapshots: () => [snapshot()],
      channelId: null,
    });

    await providerUsageLimitCheckJob(deps.overrides);

    expect(deps.overrides.getSnapshots).not.toHaveBeenCalled();
    expect(deps.postMessage).not.toHaveBeenCalled();
  });
});
