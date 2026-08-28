import { describe, expect, it, vi } from 'vitest';

vi.mock('../../encryption', () => ({
  encryptJSON: (value: unknown) => JSON.stringify(value),
  decryptSecrets: async (value: string) => JSON.parse(value) as unknown,
}));

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
});
