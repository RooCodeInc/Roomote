import {
  OPENROUTER_KEY_ENDPOINT,
  type ProviderCreditBalance,
} from '@roomote/types';

import { type DatabaseOrTransaction } from '../db';
import { resolveModelProviderEnvValue } from './model-runtime-config';

/**
 * Server-side credit-balance lookups for API-key inference providers that
 * expose a remaining-spend endpoint. Failures resolve to `null` — the settings
 * UI omits the balance line rather than erroring.
 */

const BALANCE_FETCH_TIMEOUT_MS = 10_000;

type BalanceFetchOptions = {
  executor?: DatabaseOrTransaction;
  fetchImpl?: typeof fetch;
  runtimeEnv?: Partial<Record<string, string | undefined>>;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function firstNumber(
  source: Record<string, unknown> | undefined,
  keys: readonly string[],
): number | undefined {
  for (const key of keys) {
    const value = source?.[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string' && value.trim().length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
}

async function fetchJson(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number; payload: unknown }> {
  try {
    const response = await fetchImpl(url, {
      headers,
      signal: AbortSignal.timeout(BALANCE_FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      return { status: response.status, payload: undefined };
    }

    try {
      return { status: response.status, payload: await response.json() };
    } catch {
      return { status: response.status, payload: undefined };
    }
  } catch {
    return { status: 0, payload: undefined };
  }
}

/**
 * Parse OpenRouter `GET /api/v1/key` payload.
 * Display only when `limit_remaining` is a number. Null/absent remaining
 * (uncapped key or unusable payload) yields null so the UI does not claim a
 * wallet balance.
 */
export function parseOpenRouterKeyBalance(
  payload: unknown,
): Omit<ProviderCreditBalance, 'providerId' | 'fetchedAt'> | null {
  const root = asRecord(payload);
  const data = asRecord(root?.data) ?? root;
  if (!data) {
    return null;
  }

  const remaining = firstNumber(data, ['limit_remaining']);
  if (remaining === undefined) {
    return null;
  }

  const limit = firstNumber(data, ['limit']);
  const usage = firstNumber(data, ['usage']);

  return {
    remaining,
    ...(limit !== undefined ? { limit } : {}),
    ...(usage !== undefined ? { usage } : {}),
    currency: 'USD',
  };
}

export async function fetchOpenRouterCreditBalance(
  options: BalanceFetchOptions = {},
): Promise<ProviderCreditBalance | null> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const apiKey = await resolveModelProviderEnvValue(['OPENROUTER_API_KEY'], {
    ...(options.runtimeEnv && { runtimeEnv: options.runtimeEnv }),
    ...(options.executor && { executor: options.executor }),
  });

  if (!apiKey) {
    return null;
  }

  const { payload } = await fetchJson(fetchImpl, OPENROUTER_KEY_ENDPOINT, {
    authorization: `Bearer ${apiKey}`,
    accept: 'application/json',
  });

  const parsed = parseOpenRouterKeyBalance(payload);
  if (!parsed) {
    return null;
  }

  return {
    providerId: 'openrouter',
    ...parsed,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Fetch credit balances for every supported keyed provider. Providers that are
 * not connected, fail to respond, or return nothing displayable are omitted.
 */
export async function getProviderCreditBalances(
  options: BalanceFetchOptions = {},
): Promise<ProviderCreditBalance[]> {
  const results = await Promise.allSettled([
    fetchOpenRouterCreditBalance(options),
  ]);

  return results.flatMap((result) =>
    result.status === 'fulfilled' && result.value !== null
      ? [result.value]
      : [],
  );
}
