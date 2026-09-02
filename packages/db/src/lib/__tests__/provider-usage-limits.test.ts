import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockGetChatGptSubscription,
  mockGetFreshChatGptAccessToken,
  mockGetGitHubCopilotAccessToken,
  mockGetFreshXaiAccessToken,
  mockGetXaiSubscription,
} = vi.hoisted(() => ({
  mockGetChatGptSubscription: vi.fn(),
  mockGetFreshChatGptAccessToken: vi.fn(),
  mockGetGitHubCopilotAccessToken: vi.fn(),
  mockGetFreshXaiAccessToken: vi.fn(),
  mockGetXaiSubscription: vi.fn(),
}));

vi.mock('../../encryption', () => ({
  encryptJSON: (value: unknown) => JSON.stringify(value),
  decryptSecrets: async (value: string) => JSON.parse(value) as unknown,
}));

vi.mock('../chatgpt-subscription', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../chatgpt-subscription')>();
  return {
    ...actual,
    getChatGptSubscription: mockGetChatGptSubscription,
    getFreshChatGptAccessToken: mockGetFreshChatGptAccessToken,
  };
});

vi.mock('../github-copilot-subscription', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../github-copilot-subscription')>();
  return {
    ...actual,
    getGitHubCopilotAccessToken: mockGetGitHubCopilotAccessToken,
  };
});

vi.mock('../xai-subscription', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../xai-subscription')>();
  return {
    ...actual,
    getFreshXaiAccessToken: mockGetFreshXaiAccessToken,
    getXaiSubscription: mockGetXaiSubscription,
  };
});

import {
  fingerprintProviderCredential,
  getProviderUsageLimitSnapshots,
} from '../provider-usage-limits';

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status });
}

describe('fingerprintProviderCredential', () => {
  it('returns a stable non-secret identifier', () => {
    const fingerprint = fingerprintProviderCredential('secret-key');

    expect(fingerprint).toHaveLength(12);
    expect(fingerprint).toBe(fingerprintProviderCredential('secret-key'));
    expect(fingerprint).not.toContain('secret');
    expect(fingerprint).not.toBe(
      fingerprintProviderCredential('different-key'),
    );
  });
});

describe('getProviderUsageLimitSnapshots', () => {
  beforeEach(() => {
    mockGetChatGptSubscription.mockReset().mockResolvedValue(null);
    mockGetFreshChatGptAccessToken.mockReset().mockResolvedValue(null);
    mockGetGitHubCopilotAccessToken.mockReset().mockResolvedValue(null);
    mockGetFreshXaiAccessToken.mockReset().mockResolvedValue(null);
    mockGetXaiSubscription.mockReset().mockResolvedValue(null);
  });

  it('uses weekly limit_remaining instead of all-time OpenRouter usage', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        data: {
          label: 'Reviews\nkey',
          limit: 100,
          limit_remaining: 5,
          limit_reset: 'weekly',
          usage: 900,
        },
      }),
    );

    const snapshots = await getProviderUsageLimitSnapshots({
      runtimeEnv: { OPENROUTER_API_KEY: 'or-secret' },
      fetchImpl,
    });

    expect(snapshots).toEqual([
      expect.objectContaining({
        providerId: 'openrouter',
        providerName: 'OpenRouter',
        credentialLabel: expect.stringMatching(
          /^Reviews key \([a-f0-9]{12}\)$/,
        ),
        windowLabel: 'Weekly limit',
        resetCadence: 'weekly',
        used: 95,
        remaining: 5,
        limit: 100,
        usedPercent: 95,
        currency: 'USD',
      }),
    ]);
  });

  it('reports a weekly OpenRouter key with no remaining limit as 100% used', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        data: {
          label: 'Review jobs',
          limit: 250,
          limit_remaining: 0,
          limit_reset: 'weekly',
          usage: 4_000,
          usage_weekly: 250,
        },
      }),
    );

    const snapshots = await getProviderUsageLimitSnapshots({
      runtimeEnv: { OPENROUTER_API_KEY: 'or-secret' },
      fetchImpl,
    });

    expect(snapshots[0]).toMatchObject({
      windowLabel: 'Weekly limit',
      resetCadence: 'weekly',
      used: 250,
      remaining: 0,
      limit: 250,
      usedPercent: 100,
    });
  });

  it('includes configured API-key subscription quota windows', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        data: [
          {
            model_name: 'all',
            limit: 1_000,
            used: 850,
            name: 'Weekly limit',
            reset_at: '2026-08-24T00:00:00.000Z',
          },
        ],
      }),
    );

    const snapshots = await getProviderUsageLimitSnapshots({
      runtimeEnv: { KIMI_API_KEY: 'kimi-secret' },
      fetchImpl,
    });

    expect(snapshots).toEqual([
      expect.objectContaining({
        providerId: 'kimi-for-coding',
        providerName: 'Kimi for Coding',
        credentialLabel: expect.stringMatching(/^key [a-f0-9]{12}$/),
        windowLabel: 'Weekly limit',
        usedPercent: 85,
        used: 850,
        limit: 1_000,
        resetsAt: '2026-08-24T00:00:00.000Z',
      }),
    ]);
  });

  it('includes connected ChatGPT subscription quota windows', async () => {
    mockGetChatGptSubscription.mockResolvedValue({
      refresh: 'refresh-token',
      access: 'chatgpt-access',
      expires: Date.now() + 60 * 60 * 1000,
      accountId: 'acct-1',
      status: 'connected',
      fastMode: false,
      connectedAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    });
    mockGetFreshChatGptAccessToken.mockResolvedValue({
      access: 'chatgpt-access',
      accountId: 'acct-1',
    });
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        plan_type: 'pro',
        rate_limit: {
          primary_window: {
            used_percent: 86,
            limit_window_seconds: 604_800,
            reset_at: 1_788_134_400,
          },
        },
      }),
    );

    const snapshots = await getProviderUsageLimitSnapshots({ fetchImpl });

    expect(snapshots).toEqual([
      expect.objectContaining({
        providerId: 'chatgpt',
        providerName: 'ChatGPT (subscription)',
        credentialFingerprint: expect.stringMatching(/^[a-f0-9]{12}$/),
        windowLabel: 'Weekly limit',
        usedPercent: 86,
        resetsAt: new Date(1_788_134_400 * 1000).toISOString(),
      }),
    ]);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://chatgpt.com/backend-api/wham/usage',
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: 'Bearer chatgpt-access',
          'ChatGPT-Account-Id': 'acct-1',
        }),
      }),
    );
  });

  it('keeps the ChatGPT fingerprint stable when refresh tokens rotate', async () => {
    const subscription = {
      access: 'chatgpt-access',
      expires: Date.now() + 60 * 60 * 1000,
      status: 'connected' as const,
      fastMode: false,
      connectedAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    };
    mockGetChatGptSubscription
      .mockResolvedValueOnce({
        ...subscription,
        refresh: 'first-refresh-token',
      })
      .mockResolvedValueOnce({
        ...subscription,
        refresh: 'rotated-refresh-token',
      })
      .mockResolvedValueOnce({
        ...subscription,
        refresh: 'different-account-token',
        connectedAt: '2026-09-01T00:00:00.000Z',
      });
    mockGetFreshChatGptAccessToken.mockResolvedValue({
      access: 'chatgpt-access',
    });
    const fetchImpl = vi.fn().mockImplementation(async () =>
      jsonResponse({
        rate_limit: {
          primary_window: {
            used_percent: 86,
            limit_window_seconds: 604_800,
          },
        },
      }),
    );

    const first = await getProviderUsageLimitSnapshots({ fetchImpl });
    const second = await getProviderUsageLimitSnapshots({ fetchImpl });
    const reconnected = await getProviderUsageLimitSnapshots({ fetchImpl });

    expect(first[0]?.credentialFingerprint).toBe(
      second[0]?.credentialFingerprint,
    );
    expect(reconnected[0]?.credentialFingerprint).not.toBe(
      first[0]?.credentialFingerprint,
    );
  });

  it('includes connected Copilot and xAI subscription quota windows', async () => {
    mockGetGitHubCopilotAccessToken.mockResolvedValue('copilot-access');
    mockGetFreshXaiAccessToken.mockResolvedValue({
      access: 'xai-access',
      expires: Date.now() + 60 * 60 * 1000,
    });
    mockGetXaiSubscription.mockResolvedValue({
      refresh: 'xai-refresh',
      access: 'xai-access',
      expires: Date.now() + 60 * 60 * 1000,
      status: 'connected',
      connectedAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    });
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url === 'https://api.github.com/copilot_internal/user') {
        return jsonResponse({
          quota_snapshots: {
            premium_interactions: {
              entitlement: 300,
              remaining: 30,
              percent_remaining: 10,
              unlimited: false,
            },
          },
          quota_reset_date: '2026-10-01',
        });
      }
      if (url === 'https://cli-chat-proxy.grok.com/v1/user') {
        return jsonResponse({ userId: 'xai-user' });
      }
      if (url === 'https://cli-chat-proxy.grok.com/v1/billing?format=credits') {
        return jsonResponse({ config: { creditUsagePercent: 88 } });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const snapshots = await getProviderUsageLimitSnapshots({ fetchImpl });

    expect(snapshots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          providerId: 'github-copilot',
          providerName: 'GitHub Copilot',
          windowLabel: 'Premium requests',
          usedPercent: 90,
          used: 270,
          remaining: 30,
          limit: 300,
        }),
        expect.objectContaining({
          providerId: 'xai-subscription',
          providerName: 'xAI (Grok subscription)',
          windowLabel: 'Included usage',
          usedPercent: 88,
        }),
      ]),
    );
  });
});
