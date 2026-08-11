import {
  OPENCODE_GO_API_KEY_ENV_VAR_NAME,
  OPENCODE_GO_USAGE_ENDPOINT,
  type SubscriptionProviderUsage,
  type SubscriptionUsageWindow,
} from '@roomote/types';

import { resolveModelProviderEnvValue } from '../model-runtime-config';
import {
  asRecord,
  clampPercent,
  fetchJson,
  firstNumber,
  toResetIso,
  type UsageFetchOptions,
} from './shared';

const USAGE_WINDOWS = [
  ['rolling', 'Rolling limit'],
  ['weekly', 'Weekly limit'],
  ['monthly', 'Monthly limit'],
] as const;

export function parseOpenCodeGoUsage(
  payload: unknown,
): SubscriptionUsageWindow[] {
  const usage = asRecord(asRecord(payload)?.usage);

  if (!usage) return [];

  return USAGE_WINDOWS.flatMap(([key, label]) => {
    const window = asRecord(usage[key]);
    const usedPercent = firstNumber(window, ['percent', 'usedPercent']);

    if (usedPercent === undefined) return [];

    const resetsAt = toResetIso(window?.resetsAt ?? window?.resets_at);
    return [
      {
        label,
        usedPercent: clampPercent(usedPercent),
        ...(resetsAt && { resetsAt }),
      },
    ];
  });
}

export async function fetchOpenCodeGoUsage(
  options: UsageFetchOptions = {},
): Promise<SubscriptionProviderUsage | null> {
  const apiKey = await resolveModelProviderEnvValue(
    [OPENCODE_GO_API_KEY_ENV_VAR_NAME],
    {
      ...(options.runtimeEnv && { runtimeEnv: options.runtimeEnv }),
      ...(options.executor && { executor: options.executor }),
    },
  );
  if (!apiKey) return null;

  const { payload } = await fetchJson(
    options.fetchImpl ?? fetch,
    OPENCODE_GO_USAGE_ENDPOINT,
    {
      authorization: `Bearer ${apiKey}`,
      accept: 'application/json',
    },
  );
  const windows = parseOpenCodeGoUsage(payload);

  return windows.length > 0
    ? {
        providerId: 'opencode-go',
        windows,
        fetchedAt: new Date().toISOString(),
      }
    : null;
}
