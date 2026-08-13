import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetFreshXaiAccessToken } = vi.hoisted(() => ({
  mockGetFreshXaiAccessToken: vi.fn(),
}));

vi.mock('../../encryption', () => ({
  encryptJSON: (value: unknown) => JSON.stringify(value),
  decryptSecrets: async (value: string) => JSON.parse(value) as unknown,
}));

vi.mock('../xai-subscription', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../xai-subscription')>();
  return {
    ...actual,
    getFreshXaiAccessToken: mockGetFreshXaiAccessToken,
  };
});

import {
  fetchChatGptUsage,
  fetchGitHubCopilotUsage,
  fetchKimiForCodingUsage,
  fetchOpenCodeGoUsage,
  fetchXaiSubscriptionUsage,
  fetchZaiCodingPlanUsage,
  fetchZaiUsage,
  getSubscriptionProviderUsage,
  parseOpenCodeGoUsage,
  parseXaiSubscriptionUsage,
  parseZaiQuotaUsage,
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
      if (new URL(String(url)).hostname === 'api.kimi.com') {
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

describe('fetchOpenCodeGoUsage', () => {
  it('normalizes rolling, weekly, and monthly usage windows', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        usage: {
          rolling: { percent: 12, resetsAt: '2026-08-12T01:00:00.000Z' },
          weekly: { percent: 8, resetsAt: '2026-08-17T00:00:00.000Z' },
          monthly: { percent: 35, resetsAt: '2026-09-01T00:00:00.000Z' },
        },
      }),
    );

    const usage = await fetchOpenCodeGoUsage({
      fetchImpl,
      runtimeEnv: { OPENCODE_GO_API_KEY: 'opencode-go-test' },
    });

    expect(usage).toMatchObject({
      providerId: 'opencode-go',
      windows: [
        {
          label: 'Rolling limit',
          usedPercent: 12,
          resetsAt: '2026-08-12T01:00:00.000Z',
        },
        {
          label: 'Weekly limit',
          usedPercent: 8,
          resetsAt: '2026-08-17T00:00:00.000Z',
        },
        {
          label: 'Monthly limit',
          usedPercent: 35,
          resetsAt: '2026-09-01T00:00:00.000Z',
        },
      ],
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://opencode.ai/zen/go/v1/usage',
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: 'Bearer opencode-go-test',
        }),
      }),
    );
  });

  it('omits unavailable or unrecognized usage', async () => {
    const executor = {
      query: {
        environmentVariables: { findMany: vi.fn().mockResolvedValue([]) },
      },
    } as never;
    const fetchImpl = vi.fn();

    await expect(
      fetchOpenCodeGoUsage({ executor, fetchImpl, runtimeEnv: {} }),
    ).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(parseOpenCodeGoUsage({ usage: { rolling: {} } })).toEqual([]);
  });

  it('soft-fails when the usage endpoint rejects the credential', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, 403));

    await expect(
      fetchOpenCodeGoUsage({
        fetchImpl,
        runtimeEnv: { OPENCODE_GO_API_KEY: 'invalid-opencode-go-key' },
      }),
    ).resolves.toBeNull();
  });
});

describe('parseXaiSubscriptionUsage', () => {
  it('normalizes included usage, credits, and on-demand windows', () => {
    const windows = parseXaiSubscriptionUsage(
      {
        included_usage: {
          used_percent: 42.5,
          used: 425,
          remaining: 575,
          limit: 1000,
          resets_at: '2026-08-01T00:00:00.000Z',
        },
        credits: { balance: 12.5 },
        on_demand: { used: 3, limit: 10 },
      },
      Date.parse('2026-07-01T00:00:00.000Z'),
    );

    expect(windows).toEqual([
      {
        label: 'Included usage',
        usedPercent: 42.5,
        used: 425,
        remaining: 575,
        limit: 1000,
        resetsAt: '2026-08-01T00:00:00.000Z',
      },
      {
        label: 'Credits',
        remaining: 12.5,
      },
      {
        label: 'On-demand',
        used: 3,
        limit: 10,
        usedPercent: 30,
      },
    ]);
  });

  it('parses the live cli-chat-proxy format=credits payload', () => {
    const windows = parseXaiSubscriptionUsage(
      {
        config: {
          currentPeriod: {
            type: 'USAGE_PERIOD_TYPE_WEEKLY',
            start: '2026-07-24T01:21:57.505552+00:00',
            end: '2026-07-31T01:21:57.505552+00:00',
          },
          creditUsagePercent: 27,
          onDemandCap: { val: 0 },
          onDemandUsed: { val: 0 },
          productUsage: [
            { product: 'GrokBuild', usagePercent: 26 },
            { product: 'Api', usagePercent: 1 },
            { product: 'GrokChat' },
            { product: 'GrokVoice' },
          ],
          prepaidBalance: { val: 0 },
          billingPeriodEnd: '2026-07-31T01:21:57.505552+00:00',
        },
      },
      Date.parse('2026-07-26T00:00:00.000Z'),
    );

    // Only the aggregate pool renders: the per-product entries slice the
    // same shared pool (duplicate-looking bars), and a zero on-demand
    // credit balance is the idle state, not a warning.
    expect(windows).toEqual([
      {
        label: 'Included usage',
        usedPercent: 27,
        resetsAt: '2026-07-31T01:21:57.505Z',
      },
    ]);
  });

  it('shows the credit balance only when on-demand credits exist', () => {
    const windows = parseXaiSubscriptionUsage(
      {
        config: {
          creditUsagePercent: 100,
          prepaidBalance: { val: 12.5 },
          billingPeriodEnd: '2026-07-31T01:21:57.505552+00:00',
        },
      },
      Date.parse('2026-07-26T00:00:00.000Z'),
    );

    // Pool exhausted with a positive balance: tasks continue on metered
    // spend, which is exactly when the operator needs to see the number.
    expect(windows).toEqual([
      {
        label: 'Included usage',
        usedPercent: 100,
        resetsAt: '2026-07-31T01:21:57.505Z',
      },
      {
        label: 'Credits',
        remaining: 12.5,
      },
    ]);
  });

  it('parses the live monthly billing payload', () => {
    const windows = parseXaiSubscriptionUsage(
      {
        config: {
          monthlyLimit: { val: 150_000 },
          used: { val: 73_743 },
          billingPeriodEnd: '2026-08-01T00:00:00+00:00',
        },
      },
      Date.parse('2026-07-26T00:00:00.000Z'),
    );

    expect(windows).toEqual([
      {
        label: 'Included usage',
        used: 73_743,
        limit: 150_000,
        usedPercent: 49.162,
        resetsAt: '2026-08-01T00:00:00.000Z',
      },
    ]);
  });

  it('returns an empty list for unusable payloads', () => {
    expect(parseXaiSubscriptionUsage(null)).toEqual([]);
    expect(parseXaiSubscriptionUsage({})).toEqual([]);
    expect(parseXaiSubscriptionUsage({ plan: 'pro' })).toEqual([]);
  });

  it('does not invent a window from period metadata without creditUsagePercent', () => {
    // Live cli-chat-proxy response when Grok CLI identity headers are omitted:
    // 200 with weekly period fields, but no creditUsagePercent / productUsage.
    expect(
      parseXaiSubscriptionUsage({
        config: {
          currentPeriod: {
            type: 'USAGE_PERIOD_TYPE_WEEKLY',
            start: '2026-08-07T01:21:57.505552+00:00',
            end: '2026-08-14T01:21:57.505552+00:00',
          },
          onDemandCap: { val: 0 },
          onDemandUsed: { val: 0 },
          isUnifiedBillingUser: true,
          prepaidBalance: { val: 0 },
          topUpMethod: 'TOP_UP_METHOD_SAVED_PAYMENT_METHOD',
          billingPeriodStart: '2026-08-07T01:21:57.505552+00:00',
          billingPeriodEnd: '2026-08-14T01:21:57.505552+00:00',
        },
      }),
    ).toEqual([]);
  });
});

describe('fetchXaiSubscriptionUsage', () => {
  beforeEach(() => {
    mockGetFreshXaiAccessToken.mockReset();
  });

  it('fetches user then billing and returns normalized windows', async () => {
    mockGetFreshXaiAccessToken.mockResolvedValue({
      access: 'xai-access',
      expires: Date.now() + 3_600_000,
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ userId: 'user-1' }))
      .mockResolvedValueOnce(
        jsonResponse({
          includedUsage: {
            usedPercent: 10,
            limit: 100,
            remaining: 90,
          },
        }),
      );

    const usage = await fetchXaiSubscriptionUsage({ fetchImpl });

    expect(usage).toMatchObject({
      providerId: 'xai-subscription',
      windows: [
        {
          label: 'Included usage',
          usedPercent: 10,
          limit: 100,
          remaining: 90,
        },
      ],
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      'https://cli-chat-proxy.grok.com/v1/user',
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: 'Bearer xai-access',
        }),
      }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      'https://cli-chat-proxy.grok.com/v1/billing?format=credits',
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: 'Bearer xai-access',
          'X-XAI-Token-Auth': 'xai-grok-cli',
          'x-grok-client-identifier': 'grok-shell',
          'x-grok-client-mode': 'billing',
          'x-userid': 'user-1',
        }),
      }),
    );
  });

  it('sends Grok CLI identity headers so the billing proxy returns usage', async () => {
    mockGetFreshXaiAccessToken.mockResolvedValue({
      access: 'xai-access',
      expires: Date.now() + 3_600_000,
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ userId: 'user-1' }))
      .mockResolvedValueOnce(
        jsonResponse({
          config: { creditUsagePercent: 27 },
        }),
      );

    const usage = await fetchXaiSubscriptionUsage({ fetchImpl });

    expect(usage).toMatchObject({
      providerId: 'xai-subscription',
      windows: [{ label: 'Included usage', usedPercent: 27 }],
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      'https://cli-chat-proxy.grok.com/v1/user',
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: 'Bearer xai-access',
          'user-agent': 'roomote',
        }),
      }),
    );
    const userHeaders = (
      fetchImpl.mock.calls[0]?.[1] as { headers: Record<string, string> }
    ).headers;
    expect(userHeaders).not.toHaveProperty('X-XAI-Token-Auth');
    expect(userHeaders).not.toHaveProperty('x-grok-client-identifier');
    expect(userHeaders).not.toHaveProperty('x-grok-client-mode');
    expect(userHeaders).not.toHaveProperty('x-userid');
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      'https://cli-chat-proxy.grok.com/v1/billing?format=credits',
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: 'Bearer xai-access',
          'X-XAI-Token-Auth': 'xai-grok-cli',
          'x-grok-client-identifier': 'grok-shell',
          'x-grok-client-mode': 'billing',
          'x-userid': 'user-1',
        }),
      }),
    );
  });

  it('returns null when no subscription is connected', async () => {
    mockGetFreshXaiAccessToken.mockResolvedValue(null);
    const fetchImpl = vi.fn();
    await expect(fetchXaiSubscriptionUsage({ fetchImpl })).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns null when the billing payload cannot be parsed', async () => {
    mockGetFreshXaiAccessToken.mockResolvedValue({
      access: 'xai-access',
      expires: Date.now() + 3_600_000,
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'user-1' }))
      .mockResolvedValueOnce(jsonResponse({ status: 'ok' }));

    await expect(fetchXaiSubscriptionUsage({ fetchImpl })).resolves.toBeNull();
  });
});

describe('parseZaiQuotaUsage', () => {
  it('normalizes live monitor quota windows and plan level', () => {
    const parsed = parseZaiQuotaUsage({
      code: 200,
      data: {
        level: 'lite',
        limits: [
          {
            type: 'TOKENS_LIMIT',
            unit: 3,
            percentage: 16,
            nextResetTime: 1_777_819_631_597,
          },
          {
            type: 'TOKENS_LIMIT',
            unit: 6,
            percentage: 4,
            nextResetTime: 1_778_262_784_969,
          },
          {
            type: 'TIME_LIMIT',
            unit: 5,
            percentage: 0,
            nextResetTime: 1_780_336_384_978,
          },
        ],
      },
    });

    expect(parsed.planType).toBe('lite');
    expect(parsed.windows).toEqual([
      {
        label: '5h limit',
        usedPercent: 16,
        resetsAt: new Date(1_777_819_631_597).toISOString(),
      },
      {
        label: 'Weekly limit',
        usedPercent: 4,
        resetsAt: new Date(1_778_262_784_969).toISOString(),
      },
      {
        label: 'Monthly tools',
        usedPercent: 0,
        resetsAt: new Date(1_780_336_384_978).toISOString(),
      },
    ]);
  });

  it('derives usedPercent from remaining/limit when percentage is absent', () => {
    const parsed = parseZaiQuotaUsage([
      {
        type: 'TOKENS_LIMIT',
        unit: 3,
        remaining: 75,
        limit: 100,
      },
    ]);

    expect(parsed.windows).toEqual([
      {
        label: '5h limit',
        usedPercent: 25,
        remaining: 75,
        limit: 100,
      },
    ]);
  });

  it('returns empty windows for unusable payloads', () => {
    expect(parseZaiQuotaUsage(null)).toEqual({ windows: [] });
    expect(parseZaiQuotaUsage({})).toEqual({ windows: [] });
    expect(parseZaiQuotaUsage({ code: 200, data: { level: 'pro' } })).toEqual({
      planType: 'pro',
      windows: [],
    });
  });
});

describe('fetchZaiUsage', () => {
  it('returns null when no API key is configured', async () => {
    const fetchImpl = vi.fn();
    await expect(
      fetchZaiUsage({ runtimeEnv: {}, fetchImpl }),
    ).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fetches the international quota endpoint by default', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        code: 200,
        data: {
          level: 'pro',
          limits: [{ type: 'TOKENS_LIMIT', unit: 3, percentage: 12 }],
        },
      }),
    );

    const usage = await fetchZaiUsage({
      runtimeEnv: { ZAI_API_KEY: 'zai-key' },
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.z.ai/api/monitor/usage/quota/limit',
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: 'Bearer zai-key',
        }),
      }),
    );
    expect(usage).toMatchObject({
      providerId: 'zai',
      planType: 'pro',
      windows: [{ label: '5h limit', usedPercent: 12 }],
    });
  });

  it('returns null on non-OK responses without throwing', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, 401));

    await expect(
      fetchZaiUsage({ runtimeEnv: { ZAI_API_KEY: 'zai-key' }, fetchImpl }),
    ).resolves.toBeNull();
    expect(fetchImpl).toHaveBeenCalled();
  });

  it('returns null on HTTP 200 business auth failures', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        code: 1000,
        msg: 'Authentication Failed',
        success: false,
      }),
    );

    await expect(
      fetchZaiUsage({ runtimeEnv: { ZAI_API_KEY: 'bad-key' }, fetchImpl }),
    ).resolves.toBeNull();
  });

  it('parses live coding-plan TIME_LIMIT rows with currentValue/usage', () => {
    const parsed = parseZaiQuotaUsage({
      code: 200,
      success: true,
      data: {
        level: 'max',
        limits: [
          { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 0 },
          {
            type: 'TOKENS_LIMIT',
            unit: 6,
            number: 1,
            percentage: 30,
            nextResetTime: 1_785_560_352_998,
          },
          {
            type: 'TIME_LIMIT',
            unit: 5,
            number: 1,
            usage: 4000,
            currentValue: 24,
            remaining: 3976,
            percentage: 1,
            nextResetTime: 1_785_819_552_997,
          },
        ],
      },
    });

    expect(parsed.planType).toBe('max');
    expect(parsed.windows).toEqual([
      { label: '5h limit', usedPercent: 0 },
      {
        label: 'Weekly limit',
        usedPercent: 30,
        resetsAt: new Date(1_785_560_352_998).toISOString(),
      },
      {
        label: 'Monthly tools',
        usedPercent: 1,
        used: 24,
        remaining: 3976,
        limit: 4000,
        resetsAt: new Date(1_785_819_552_997).toISOString(),
      },
    ]);
  });

  it('uses the China host when ZAI_REGION is china', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        code: 200,
        data: {
          limits: [{ type: 'TOKENS_LIMIT', unit: 6, percentage: 8 }],
        },
      }),
    );

    await fetchZaiUsage({
      runtimeEnv: { ZAI_API_KEY: 'zai-key', ZAI_REGION: 'china' },
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://open.bigmodel.cn/api/monitor/usage/quota/limit',
      expect.anything(),
    );
  });

  it('returns null when the payload has no displayable windows', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ code: 200, data: { level: 'lite' } }));

    await expect(
      fetchZaiUsage({ runtimeEnv: { ZAI_API_KEY: 'zai-key' }, fetchImpl }),
    ).resolves.toBeNull();
  });
});

describe('fetchZaiCodingPlanUsage', () => {
  it('fetches coding-plan keys against the same monitor path', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        code: 200,
        data: {
          level: 'max',
          limits: [{ type: 'TOKENS_LIMIT', unit: 6, percentage: 33 }],
        },
      }),
    );

    const usage = await fetchZaiCodingPlanUsage({
      runtimeEnv: {
        ZAI_CODING_PLAN_API_KEY: 'coding-key',
        ZAI_CODING_PLAN_REGION: 'global',
      },
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.z.ai/api/monitor/usage/quota/limit',
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: 'Bearer coding-key',
        }),
      }),
    );
    expect(usage).toMatchObject({
      providerId: 'zai-coding-plan',
      planType: 'max',
      windows: [{ label: 'Weekly limit', usedPercent: 33 }],
    });
  });
});
