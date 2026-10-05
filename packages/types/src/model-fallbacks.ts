import { isInferenceCreditsExhaustedError } from './inference-credits-exhaustion';
import {
  TASK_MODEL_ROLES,
  type ModelFallbackRuntime,
  type TaskModelRole,
} from './model-provider-config';
import { asFiniteNumber, asRecord, asString } from './primitives';
import { isReasoningEffort, type ReasoningEffort } from './task-runs';
import {
  isTaskModelIdDisabled,
  normalizeTaskModelId,
  resolveTaskModelIdAlias,
} from './task-models';

export type ModelFallbackRoleConfig = {
  modelId: string;
  reasoningEffort: ReasoningEffort | null;
};

export type ModelFallbackConfig = {
  enabled: boolean;
  roles: Partial<Record<TaskModelRole, ModelFallbackRoleConfig>>;
};

export type ModelFallbackTrigger = 'immediate' | 'after_retries';

export const MODEL_FALLBACK_PROVIDER_ERROR_RETRIES = 3;

export const MODEL_FALLBACK_AGENT_ROLES = {
  visual: 'vision',
  judge: 'vision',
  advisor: 'planning',
  explore: 'explore',
} as const satisfies Record<string, TaskModelRole>;

export const MODEL_FALLBACK_RUNTIME_COVERAGE = {
  harness: 'enforced',
  subagent: 'enforced',
  fast: 'enforced',
  'control-plane': 'enforced',
  'opencode-internal': 'not-observable',
} as const satisfies Record<
  ModelFallbackRuntime,
  'enforced' | 'not-observable'
>;

export function normalizeModelFallbackConfig(
  raw: unknown,
): ModelFallbackConfig {
  const record = asRecord(raw);
  const rawRoles = asRecord(record?.roles);
  const roles: ModelFallbackConfig['roles'] = {};

  for (const role of TASK_MODEL_ROLES) {
    const roleRecord = asRecord(rawRoles?.[role]);
    const rawModelId = asString(roleRecord?.modelId)?.trim();
    if (!rawModelId) continue;

    const modelId = resolveTaskModelIdAlias(normalizeTaskModelId(rawModelId));
    if (!modelId || isTaskModelIdDisabled(modelId)) continue;

    roles[role] = {
      modelId,
      reasoningEffort: isReasoningEffort(roleRecord?.reasoningEffort)
        ? roleRecord.reasoningEffort
        : null,
    };
  }

  return { enabled: record?.enabled === true, roles };
}

export function resolveRoleFallback(
  config: ModelFallbackConfig,
  role: TaskModelRole,
  activeModelId: string,
): ModelFallbackRoleConfig | null {
  if (!config.enabled) return null;
  const fallback = config.roles[role];
  return fallback && fallback.modelId !== normalizeTaskModelId(activeModelId)
    ? fallback
    : null;
}

function collectErrorValues(error: unknown): unknown[] {
  const queue: Array<{ value: unknown; depth: number }> = [
    { value: error, depth: 0 },
  ];
  const values: unknown[] = [];
  const seen = new Set<object>();
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || current.depth > 6) continue;
    values.push(current.value);
    if (typeof current.value === 'string') {
      try {
        queue.push({
          value: JSON.parse(current.value),
          depth: current.depth + 1,
        });
      } catch {
        // Provider prose remains available to the classifiers below.
      }
      continue;
    }
    if (
      !current.value ||
      typeof current.value !== 'object' ||
      seen.has(current.value)
    )
      continue;
    seen.add(current.value);
    for (const nested of Object.values(current.value)) {
      queue.push({ value: nested, depth: current.depth + 1 });
    }
  }
  return values;
}

export function collectProviderErrorValues(error: unknown): unknown[] {
  return collectErrorValues(error);
}

export function extractProviderErrorHttpStatus(
  values: unknown[],
): number | undefined {
  for (const value of values) {
    const record = asRecord(value);
    if (!record) continue;
    for (const key of ['statusCode', 'status', 'code'] as const) {
      const candidate =
        asFiniteNumber(record[key]) ??
        (typeof record[key] === 'string' && /^\d{3}$/u.test(record[key].trim())
          ? Number(record[key].trim())
          : undefined);
      if (
        candidate &&
        Number.isInteger(candidate) &&
        candidate >= 400 &&
        candidate <= 599
      )
        return candidate;
    }
  }
  return undefined;
}

export function classifyModelFallbackTrigger(
  error: unknown,
  { retriesUsed }: { retriesUsed: number },
): ModelFallbackTrigger | null {
  if (isInferenceCreditsExhaustedError(error)) return 'immediate';
  const values = collectProviderErrorValues(error);
  const records = values.flatMap((value) => {
    const record = asRecord(value);
    return record ? [record] : [];
  });
  const names = new Set(
    records
      .map((record) => asString(record.name)?.trim().toLowerCase())
      .filter((name): name is string => Boolean(name)),
  );
  const text = values
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .toLowerCase();
  const status = extractProviderErrorHttpStatus(values);
  const gatewayBlocked =
    status === 403 &&
    (values.some(
      (value) =>
        typeof value === 'string' && /^\s*(?:<!doctype|<html)/iu.test(value),
    ) ||
      text.includes('request was blocked by a gateway or proxy'));

  if (
    names.has('contentfiltererror') ||
    names.has('contextoverflowerror') ||
    names.has('messageoutputlengtherror') ||
    names.has('structuredoutputerror') ||
    names.has('messageabortederror') ||
    text.includes('content_filter')
  ) {
    return null;
  }
  if (status === 404 || names.has('providermodelnotfounderror'))
    return 'immediate';
  if (
    !gatewayBlocked &&
    (status === 401 || status === 403 || names.has('providerautherror'))
  ) {
    return 'immediate';
  }
  const retryable =
    gatewayBlocked ||
    status === undefined ||
    status === 408 ||
    status === 429 ||
    status >= 500 ||
    records.some((record) => record.isRetryable === true);
  return retryable && retriesUsed >= MODEL_FALLBACK_PROVIDER_ERROR_RETRIES
    ? 'after_retries'
    : null;
}
