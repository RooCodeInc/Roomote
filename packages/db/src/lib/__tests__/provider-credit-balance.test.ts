import { describe, expect, it, vi } from 'vitest';

vi.mock('../../encryption', () => ({
  encryptJSON: (value: unknown) => JSON.stringify(value),
  decryptSecrets: async (value: string) => JSON.parse(value) as unknown,
}));

import {
  fetchOpenRouterCreditBalance,
  getProviderCreditBalances,
  parseOpenRouterKeyBalance,
  parseOpenRouterKeyDetails,
} from '../provider-credit-balance';

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status });
}

describe('parseOpenRouterKeyBalance', () => {
  it('parses nested data.limit_remaining with optional limit and usage', () => {
    expect(
      parseOpenRouterKeyBalance({
        data: {
          limit: 50,
          limit_remaining: 12.5,
          usage: 37.5,
        },
      }),
    ).toEqual({
      remaining: 12.5,
      limit: 50,
      usage: 37.5,
      currency: 'USD',
    });
  });

  it('accepts a flat payload shape', () => {
    expect(
      parseOpenRouterKeyBalance({
        limit_remaining: 3,
        limit: 10,
      }),
    ).toEqual({
      remaining: 3,
      limit: 10,
      currency: 'USD',
    });
  });

  it('returns null when limit_remaining is null (uncapped key)', () => {
    expect(
      parseOpenRouterKeyBalance({
        data: {
          limit: null,
          limit_remaining: null,
          usage: 100,
        },
      }),
    ).toBeNull();
  });

  it('returns null for unusable payloads', () => {
    expect(parseOpenRouterKeyBalance(null)).toBeNull();
    expect(parseOpenRouterKeyBalance({})).toBeNull();
    expect(parseOpenRouterKeyBalance({ data: {} })).toBeNull();
  });
});

describe('fetchOpenRouterCreditBalance', () => {
  it('returns null when no API key is configured', async () => {
    const fetchImpl = vi.fn();

    await expect(
      fetchOpenRouterCreditBalance({
        runtimeEnv: {},
        fetchImpl,
      }),
    ).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fetches the OpenRouter key endpoint and normalizes remaining', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        data: {
          limit: 100,
          limit_remaining: 42,
          usage: 58,
        },
      }),
    );

    const balance = await fetchOpenRouterCreditBalance({
      runtimeEnv: { OPENROUTER_API_KEY: 'or-key' },
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/key',
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: 'Bearer or-key',
        }),
      }),
    );
    expect(balance).toMatchObject({
      providerId: 'openrouter',
      remaining: 42,
      limit: 100,
      currency: 'USD',
    });
    expect(balance?.fetchedAt).toEqual(expect.any(String));
  });

  it('resolves null on non-OK responses', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, 401));

    await expect(
      fetchOpenRouterCreditBalance({
        runtimeEnv: { OPENROUTER_API_KEY: 'or-key' },
        fetchImpl,
      }),
    ).resolves.toBeNull();
  });

  it('resolves null when fetch throws', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network'));

    await expect(
      fetchOpenRouterCreditBalance({
        runtimeEnv: { OPENROUTER_API_KEY: 'or-key' },
        fetchImpl,
      }),
    ).resolves.toBeNull();
  });
});

describe('parseOpenRouterKeyDetails', () => {
  it('parses the key label and reset cadence used by usage warnings', () => {
    expect(
      parseOpenRouterKeyDetails({
        data: {
          label: 'Production reviews',
          limit: 500,
          limit_remaining: 75,
          limit_reset: 'weekly',
          usage: 900,
        },
      }),
    ).toEqual({
      label: 'Production reviews',
      limit: 500,
      limitRemaining: 75,
      limitReset: 'weekly',
      usage: 900,
    });
  });

  it('rejects unlimited and invalid limits', () => {
    expect(
      parseOpenRouterKeyDetails({
        data: { limit: null, limit_remaining: null },
      }),
    ).toBeNull();
    expect(
      parseOpenRouterKeyDetails({ data: { limit: 0, limit_remaining: 0 } }),
    ).toBeNull();
  });
});

describe('getProviderCreditBalances', () => {
  it('includes successful provider balances', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        data: { limit_remaining: 1, limit: 2 },
      }),
    );

    const balances = await getProviderCreditBalances({
      runtimeEnv: { OPENROUTER_API_KEY: 'or-key' },
      fetchImpl,
    });

    expect(balances).toHaveLength(1);
    expect(balances[0]).toMatchObject({
      providerId: 'openrouter',
      remaining: 1,
    });
  });

  it('omits providers that fail', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('down'));

    await expect(
      getProviderCreditBalances({
        runtimeEnv: { OPENROUTER_API_KEY: 'or-key' },
        fetchImpl,
      }),
    ).resolves.toEqual([]);
  });
});
