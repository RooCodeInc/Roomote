import { createHash } from 'node:crypto';

import {
  OPENCODE_GO_API_KEY_ENV_VAR_NAME,
  type SubscriptionProviderUsage,
  type SubscriptionUsageProviderId,
} from '@roomote/types';

import { type DatabaseOrTransaction } from '../db';
import { fetchOpenRouterKeyDetails } from './provider-credit-balance';
import { resolveModelProviderEnvValue } from './model-runtime-config';
import {
  fetchKimiForCodingUsage,
  fetchOpenCodeGoUsage,
  fetchZaiCodingPlanUsage,
  fetchZaiUsage,
} from './subscription-provider-usage';

export const PROVIDER_USAGE_WARNING_THRESHOLDS = [80, 90, 100] as const;

export type ProviderUsageWarningThreshold =
  (typeof PROVIDER_USAGE_WARNING_THRESHOLDS)[number];

export type ProviderUsageLimitSnapshot = {
  providerId: string;
  providerName: string;
  credentialFingerprint: string;
  credentialLabel: string;
  windowLabel: string;
  usedPercent: number;
  used?: number;
  remaining?: number;
  limit?: number;
  currency?: string;
  resetsAt?: string;
  resetCadence?: string;
};

type UsageLimitFetchOptions = {
  executor?: DatabaseOrTransaction;
  fetchImpl?: typeof fetch;
  runtimeEnv?: Partial<Record<string, string | undefined>>;
};

type ApiKeyUsageProvider = {
  providerId: Extract<
    SubscriptionUsageProviderId,
    'kimi-for-coding' | 'opencode-go' | 'zai' | 'zai-coding-plan'
  >;
  providerName: string;
  envVarNames: readonly string[];
  fetchUsage: (
    options: UsageLimitFetchOptions,
  ) => Promise<SubscriptionProviderUsage | null>;
};

const API_KEY_USAGE_PROVIDERS: readonly ApiKeyUsageProvider[] = [
  {
    providerId: 'kimi-for-coding',
    providerName: 'Kimi for Coding',
    envVarNames: ['KIMI_API_KEY'],
    fetchUsage: fetchKimiForCodingUsage,
  },
  {
    providerId: 'opencode-go',
    providerName: 'OpenCode Go',
    envVarNames: [OPENCODE_GO_API_KEY_ENV_VAR_NAME],
    fetchUsage: fetchOpenCodeGoUsage,
  },
  {
    providerId: 'zai',
    providerName: 'Z.AI',
    envVarNames: ['ZAI_API_KEY'],
    fetchUsage: fetchZaiUsage,
  },
  {
    providerId: 'zai-coding-plan',
    providerName: 'Z.AI Coding Plan',
    envVarNames: ['ZAI_CODING_PLAN_API_KEY'],
    fetchUsage: fetchZaiCodingPlanUsage,
  },
];

export function fingerprintProviderCredential(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex').slice(0, 12);
}

function sanitizeCredentialLabel(label: string | undefined): string | null {
  const normalized = label?.replace(/[\r\n\t]+/g, ' ').trim();
  return normalized ? normalized.slice(0, 80) : null;
}

function toSubscriptionSnapshots(params: {
  usage: SubscriptionProviderUsage;
  providerName: string;
  apiKey: string;
}): ProviderUsageLimitSnapshot[] {
  const credentialFingerprint = fingerprintProviderCredential(params.apiKey);

  return params.usage.windows.flatMap((window) =>
    window.usedPercent === undefined
      ? []
      : [
          {
            providerId: params.usage.providerId,
            providerName: params.providerName,
            credentialFingerprint,
            credentialLabel: `key ${credentialFingerprint}`,
            windowLabel: window.label,
            usedPercent: window.usedPercent,
            ...(window.used !== undefined ? { used: window.used } : {}),
            ...(window.remaining !== undefined
              ? { remaining: window.remaining }
              : {}),
            ...(window.limit !== undefined ? { limit: window.limit } : {}),
            ...(window.resetsAt ? { resetsAt: window.resetsAt } : {}),
          },
        ],
  );
}

async function fetchOpenRouterUsageLimit(
  options: UsageLimitFetchOptions,
): Promise<ProviderUsageLimitSnapshot[]> {
  const details = await fetchOpenRouterKeyDetails(options);
  if (!details) {
    return [];
  }

  const credentialFingerprint = details.credentialFingerprint;
  const credentialLabel = sanitizeCredentialLabel(details.label);
  // OpenRouter's `usage` field is all-time. `limit_remaining` is scoped to the
  // configured key cap and its `limit_reset` cadence, so this subtraction is
  // the authoritative daily/weekly/monthly usage for threshold warnings.
  const used = Math.max(0, details.limit - details.limitRemaining);

  return [
    {
      providerId: 'openrouter',
      providerName: 'OpenRouter',
      credentialFingerprint,
      credentialLabel: credentialLabel
        ? `${credentialLabel} (${credentialFingerprint})`
        : `key ${credentialFingerprint}`,
      windowLabel: details.limitReset
        ? `${details.limitReset[0]?.toUpperCase()}${details.limitReset.slice(1)} limit`
        : 'Key limit',
      usedPercent: Math.min(100, Math.max(0, (used / details.limit) * 100)),
      used,
      remaining: details.limitRemaining,
      limit: details.limit,
      currency: 'USD',
      ...(details.limitReset ? { resetCadence: details.limitReset } : {}),
    },
  ];
}

async function fetchApiKeySubscriptionUsage(
  provider: ApiKeyUsageProvider,
  options: UsageLimitFetchOptions,
): Promise<ProviderUsageLimitSnapshot[]> {
  const apiKey = await resolveModelProviderEnvValue(provider.envVarNames, {
    ...(options.runtimeEnv && { runtimeEnv: options.runtimeEnv }),
    ...(options.executor && { executor: options.executor }),
  });
  if (!apiKey) {
    return [];
  }

  const usage = await provider.fetchUsage(options);
  return usage
    ? toSubscriptionSnapshots({
        usage,
        providerName: provider.providerName,
        apiKey,
      })
    : [];
}

/** Fetch every configured API-key provider with a queryable usage endpoint. */
export async function getProviderUsageLimitSnapshots(
  options: UsageLimitFetchOptions = {},
): Promise<ProviderUsageLimitSnapshot[]> {
  const results = await Promise.allSettled([
    fetchOpenRouterUsageLimit(options),
    ...API_KEY_USAGE_PROVIDERS.map((provider) =>
      fetchApiKeySubscriptionUsage(provider, options),
    ),
  ]);

  return results.flatMap((result) =>
    result.status === 'fulfilled' ? result.value : [],
  );
}
