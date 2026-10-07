import { REASONING_EFFORT_VALUES, type ReasoningEffort } from './task-runs';
import type { TaskModelMetadata } from './task-models';

// Native levels and compatibility aliases documented at
// https://api-docs.deepseek.com/guides/thinking_mode . Keep the rule scoped
// to V4.1 Flash routes; older DeepSeek models have different capabilities.
const DEEPSEEK_V41_FLASH_MODEL_IDS = new Set([
  'openrouter/deepseek/deepseek-v4.1-flash',
  'vercel/deepseek/deepseek-v4.1-flash',
  'vercel/deepseek/deepseek-v4.1-flash-beta',
  'deepseek/deepseek-flash',
  'opencode-go/deepseek-v4.1-flash',
  'opencode-go/deepseek-flash',
]);
const DEEPSEEK_V41_FLASH_EFFORTS = ['low', 'high', 'max'] as const;

export function normalizeTaskModelReasoningAlias(
  modelId: string,
  effort: ReasoningEffort,
): ReasoningEffort {
  return DEEPSEEK_V41_FLASH_MODEL_IDS.has(modelId) &&
    (effort === 'medium' || effort === 'xhigh')
    ? 'high'
    : effort;
}

export function getTaskModelReasoningEfforts(
  modelId: string,
  metadata?: TaskModelMetadata | null,
): readonly ReasoningEffort[] {
  if (metadata?.supportsReasoning === false) return [];
  const supported =
    metadata?.supportedReasoningEfforts ??
    (DEEPSEEK_V41_FLASH_MODEL_IDS.has(modelId)
      ? DEEPSEEK_V41_FLASH_EFFORTS
      : REASONING_EFFORT_VALUES);
  // Catalogs may return descending, duplicated, or alias levels. Slider
  // indices always refer to the same canonical ascending scale.
  const canonical = supported.map((effort) =>
    normalizeTaskModelReasoningAlias(modelId, effort),
  );
  return REASONING_EFFORT_VALUES.filter((effort) => canonical.includes(effort));
}

/** Resolve a saved request for display/selection without rewriting storage. */
export function resolveTaskModelReasoningEffort(
  modelId: string,
  effort: ReasoningEffort | null,
  supported: readonly ReasoningEffort[],
): ReasoningEffort | null {
  if (effort === null) return null;
  const normalized = normalizeTaskModelReasoningAlias(modelId, effort);
  const requestedIndex = REASONING_EFFORT_VALUES.indexOf(normalized);
  return supported.reduce<ReasoningEffort | null>((closest, candidate) => {
    if (!closest) return candidate;
    const candidateDistance = Math.abs(
      REASONING_EFFORT_VALUES.indexOf(candidate) - requestedIndex,
    );
    const closestDistance = Math.abs(
      REASONING_EFFORT_VALUES.indexOf(closest) - requestedIndex,
    );
    return candidateDistance < closestDistance ? candidate : closest;
  }, null);
}
