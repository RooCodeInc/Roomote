import { describe, expect, it, vi } from 'vitest';

vi.mock('../../encryption', () => ({
  encryptJSON: (value: unknown) => JSON.stringify(value),
  decryptSecrets: async (value: string) => JSON.parse(value) as unknown,
}));

import {
  fetchChatGptUsage,
  fetchGitHubCopilotUsage,
  fetchKimiForCodingUsage,
  getSubscriptionProviderUsage,
} from '../subscription-provider-usage';

/** Executor whose deployment-secret reads resolve the given rows per call. */
function makeSecretExecutor(
  rowsPerCall: Array<Record<string, unknown> | null>,
) {
  const limit = vi.fn();
  for (const row of rowsPerCall) {
    limit.mockResolvedValueOnce(row ? [{ value: JSON.stringify(row) }] : []);
  }
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  return { executor: { select } as never, select };
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status });
}

const COPILOT_RECORD = {
  access: 'gho-token',
  status: 'connected',
  connectedAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z',
};

function chatGptRecord() {
  return {
    refresh: 'refresh-token',
    access: 'chatgpt-access',
    expires: Date.now() + 60 * 60 * 1000,
    accountId: 'acct-1',
    status: 'connected',
    connectedAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
  };
}

describe('fetchGitHubCopilotUsage', () => {
  it('normalizes the premium-request quota snapshot', async () => {
    const { executor } = makeSecretExecutor([COPILOT_RECORD]);
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        quota_snapshots: {
          premium_interactions: {
            entitlement: 300,
            remaining: 211,
            percent_remaining: 70.33,
            unlimited: false,
            overage_count: 0,
          },
          chat: { unlimited: true },
        },
        quota_reset_date: '2026-08-01',
      }),
    );

    const usage = await fetchGitHubCopilotUsage({ executor, fetchImpl });

    expect(usage).toMatchObject({
      providerId: 'github-copilot',
      windows: [
        {
          label: 'Premium requests',
          used: 89,
          remaining: 211,
          limit: 300,
        },
      ],
    });
    expect(usage?.windows[0]?.usedPercent).toBeCloseTo(29.67, 2);
    expect(usage?.windows[0]?.resetsAt).toBe(
      new Date('2026-08-01').toISOString(),
    );

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.github.com/copilot_internal/user');
    expect(init.headers).toMatchObject({
      authorization: 'Bearer gho-token',
      'editor-version': 'vscode/1.99.3',
    });
  });

  it('resolves null without fetching when no subscription is connected', async () => {
    const { executor } = makeSecretExecutor([null]);
    const fetchImpl = vi.fn();

    await expect(
      fetchGitHubCopilotUsage({ executor, fetchImpl }),
    ).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('resolves null on an upstream error or unrecognized payload', async () => {
    const { executor } = makeSecretExecutor([COPILOT_RECORD, COPILOT_RECORD]);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 403))
      .mockResolvedValueOnce(jsonResponse({ unexpected: true }));

    await expect(
      fetchGitHubCopilotUsage({ executor, fetchImpl }),
    ).resolves.toBeNull();
    await expect(
      fetchGitHubCopilotUsage({ executor, fetchImpl }),
    ).resolves.toBeNull();
  });
});

describe('fetchChatGptUsage', () => {
  it('normalizes primary/secondary rate-limit windows', async () => {
    const { executor } = makeSecretExecutor([chatGptRecord()]);
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        plan_type: 'pro',
        rate_limits: {
          primary: {
            used_percent: 12.5,
            window_minutes: 300,
            resets_in_seconds: 3600,
          },
          secondary: { used_percent: 40, window_minutes: 10080 },
        },
      }),
    );

    const usage = await fetchChatGptUsage({ executor, fetchImpl });

    expect(usage).toMatchObject({
      providerId: 'chatgpt',
      planType: 'pro',
      windows: [
        { label: '5h limit', usedPercent: 12.5 },
        { label: 'Weekly limit', usedPercent: 40 },
      ],
    });
    expect(usage?.windows[0]?.resetsAt).toBeDefined();

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://chatgpt.com/backend-api/wham/usage');
    expect(init.headers).toMatchObject({
      authorization: 'Bearer chatgpt-access',
      'ChatGPT-Account-Id': 'acct-1',
    });
  });

  it('accepts the aliased array payload shape', async () => {
    const { executor } = makeSecretExecutor([chatGptRecord()]);
    const resetEpochSeconds = Math.floor(Date.now() / 1000) + 7200;
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        planType: 'plus',
        rate_limits: [
          {
            limit_id: 'codex',
            primary_window: { usedPercent: 5, limit_window_seconds: 18_000 },
            secondary_window: { percent_left: 80, reset_at: resetEpochSeconds },
          },
        ],
      }),
    );

    const usage = await fetchChatGptUsage({ executor, fetchImpl });

    expect(usage).toMatchObject({
      providerId: 'chatgpt',
      planType: 'plus',
      windows: [
        { label: '5h limit', usedPercent: 5 },
        { label: 'Weekly limit', usedPercent: 20 },
      ],
    });
    expect(usage?.windows[1]?.resetsAt).toBe(
      new Date(resetEpochSeconds * 1000).toISOString(),
    );
  });

  it('parses the live singular rate_limit payload shape', async () => {
    // Shape observed from the real endpoint on a Pro plan: a singular
    // `rate_limit` object with `primary_window` (weekly) and a null
    // `secondary_window`.
    const { executor } = makeSecretExecutor([chatGptRecord()]);
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        user_id: 'user-1',
        plan_type: 'pro',
        rate_limit: {
          allowed: true,
          limit_reached: false,
          primary_window: {
            used_percent: 8,
            limit_window_seconds: 604_800,
            reset_after_seconds: 481_997,
            reset_at: 1_784_949_989,
          },
          secondary_window: null,
        },
        credits: { has_credits: false, unlimited: false, balance: '0' },
      }),
    );

    const usage = await fetchChatGptUsage({ executor, fetchImpl });

    expect(usage).toMatchObject({
      providerId: 'chatgpt',
      planType: 'pro',
      windows: [{ label: 'Weekly limit', usedPercent: 8 }],
    });
    expect(usage?.windows[0]?.resetsAt).toBe(
      new Date(1_784_949_989 * 1000).toISOString(),
    );
  });

  it('resolves null when no subscription is connected', async () => {
    const { executor } = makeSecretExecutor([null]);
    const fetchImpl = vi.fn();

    await expect(
      fetchChatGptUsage({ executor, fetchImpl }),
    ).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('fetchKimiForCodingUsage', () => {
  it('parses the flat data-array payload using the plan-wide summary row', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        data: [
          {
            model_name: 'all',
            title: 'Weekly',
            limit: 2048,
            used: 120,
            remaining: 1928,
            reset_time: '2026-07-20T00:00:00Z',
          },
          { model_name: 'k3', limit: 1024, used: 60 },
        ],
      }),
    );

    const usage = await fetchKimiForCodingUsage({
      runtimeEnv: { KIMI_API_KEY: 'sk-kimi-test' },
      fetchImpl,
    });

    expect(usage).toMatchObject({
      providerId: 'kimi-for-coding',
      windows: [
        {
          label: 'Weekly',
          used: 120,
          remaining: 1928,
          limit: 2048,
          resetsAt: '2026-07-20T00:00:00.000Z',
        },
      ],
    });
    expect(usage?.windows[0]?.usedPercent).toBeCloseTo(5.86, 1);

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.kimi.com/coding/v1/usages');
    expect(init.headers).toMatchObject({
      authorization: 'Bearer sk-kimi-test',
      'x-api-key': 'sk-kimi-test',
    });
  });

  it('parses the live windowed payload with string numbers and proto enums', async () => {
    // Shape observed from the real endpoint: numeric fields are strings,
    // timeUnit is a proto-style enum, and top-level `usage` is the weekly
    // plan quota alongside the short-window `limits` entries.
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        user: { userId: 'u-1', membership: { level: 'LEVEL_BASIC' } },
        usage: {
          limit: '100',
          used: '27',
          remaining: '73',
          resetTime: '2026-07-25T02:26:20.963457Z',
        },
        limits: [
          {
            window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
            detail: {
              limit: '100',
              used: '34',
              remaining: '66',
              resetTime: '2026-07-19T13:26:20.963457Z',
            },
          },
        ],
      }),
    );

    const usage = await fetchKimiForCodingUsage({
      runtimeEnv: { KIMI_API_KEY: 'sk-kimi-test' },
      fetchImpl,
    });

    expect(usage).toMatchObject({
      providerId: 'kimi-for-coding',
      windows: [
        {
          label: '5h limit',
          usedPercent: 34,
          used: 34,
          remaining: 66,
          limit: 100,
          resetsAt: '2026-07-19T13:26:20.963Z',
        },
        {
          label: 'Weekly limit',
          usedPercent: 27,
          used: 27,
          remaining: 73,
          limit: 100,
          resetsAt: '2026-07-25T02:26:20.963Z',
        },
      ],
    });
  });

  it('falls back to /v1/usage on 404', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValueOnce(
        jsonResponse({
          usage: { limit: 100, used: 30 },
        }),
      );

    const usage = await fetchKimiForCodingUsage({
      runtimeEnv: { KIMI_API_KEY: 'sk-kimi-test' },
      fetchImpl,
    });

    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      'https://api.kimi.com/coding/v1/usages',
      'https://api.kimi.com/coding/v1/usage',
    ]);
    expect(usage).toMatchObject({
      providerId: 'kimi-for-coding',
      windows: [{ label: 'Usage', used: 30, remaining: 70, limit: 100 }],
    });
  });

  it('resolves null without fetching when no Kimi key is configured', async () => {
    const executor = {
      query: {
        environmentVariables: { findMany: vi.fn().mockResolvedValue([]) },
      },
    } as never;
    const fetchImpl = vi.fn();

    await expect(
      fetchKimiForCodingUsage({ executor, fetchImpl, runtimeEnv: {} }),
    ).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('getSubscriptionProviderUsage', () => {
  it('keeps working providers when another provider fails', async () => {
    // The ChatGPT fetcher reads its secret first, then Copilot reads its own.
    const { executor: secretExecutor } = makeSecretExecutor([
      null,
      COPILOT_RECORD,
    ]);
    const executor = {
      ...(secretExecutor as object),
      query: {
        environmentVariables: { findMany: vi.fn().mockResolvedValue([]) },
      },
    } as never;

    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('api.kimi.com')) {
        return jsonResponse({
          data: [{ model_name: 'all', limit: 100, used: 10 }],
        });
      }
      throw new Error('upstream unavailable');
    }) as unknown as typeof fetch;

    const usage = await getSubscriptionProviderUsage({
      executor,
      fetchImpl,
      runtimeEnv: { KIMI_API_KEY: 'sk-kimi-test' },
    });

    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ providerId: 'kimi-for-coding' });
  });
});
