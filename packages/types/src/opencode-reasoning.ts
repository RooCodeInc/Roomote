import type { ReasoningEffort } from './task-runs';

/**
 * Maps a Roomote reasoning effort to the Anthropic extended-thinking token
 * budgets OpenCode uses for its own built-in variants (`high` ~16k tokens,
 * `max` ~32k tokens).
 */
const ANTHROPIC_THINKING_BUDGET_TOKENS: Record<ReasoningEffort, number> = {
  low: 4_000,
  medium: 8_000,
  high: 16_000,
  xhigh: 31_999,
};

export function splitTaskModelId(
  modelId: string,
): { providerID: string; modelID: string } | null {
  const trimmed = modelId.trim();
  const separatorIndex = trimmed.indexOf('/');

  if (separatorIndex <= 0 || separatorIndex === trimmed.length - 1) {
    return null;
  }

  return {
    providerID: trimmed.slice(0, separatorIndex),
    modelID: trimmed.slice(separatorIndex + 1),
  };
}

function isOpenAiStyleOpenRouterModel(modelID: string): boolean {
  const normalized = modelID.toLowerCase();

  return normalized.includes('openai/') || normalized.includes('gpt');
}

/**
 * Builds the OpenCode per-model `options` payload that applies a reasoning
 * effort for the given `provider/model` id. The option keys mirror the
 * provider-specific shapes OpenCode uses for its own built-in reasoning
 * variants: OpenRouter takes `reasoning.effort`, Anthropic takes an
 * extended-thinking budget, and OpenAI-compatible providers take
 * `reasoningEffort`.
 *
 * Returns `null` when the model id cannot be parsed.
 */
export function buildOpenCodeModelReasoningOptions(
  modelId: string,
  reasoningEffort: ReasoningEffort,
): Record<string, unknown> | null {
  const selection = splitTaskModelId(modelId);

  if (!selection) {
    return null;
  }

  switch (selection.providerID) {
    case 'openrouter': {
      // OpenRouter only accepts `xhigh` on OpenAI reasoning models; clamp it
      // to `high` elsewhere so the request is not rejected outright.
      const effort =
        reasoningEffort === 'xhigh' &&
        !isOpenAiStyleOpenRouterModel(selection.modelID)
          ? 'high'
          : reasoningEffort;

      return { reasoning: { effort } };
    }
    case 'anthropic':
      return {
        thinking: {
          type: 'enabled',
          budgetTokens: ANTHROPIC_THINKING_BUDGET_TOKENS[reasoningEffort],
        },
      };
    default:
      return { reasoningEffort };
  }
}

/**
 * Merges reasoning options for one model into an OpenCode `provider` config
 * subtree (`provider.<id>.models.<model>.options`). Existing entries for the
 * same model win so higher-priority roles (for example the coding model) are
 * not overridden by lower-priority roles sharing the same model.
 */
export function mergeOpenCodeModelReasoningOptions(
  providerConfig: Record<string, unknown>,
  modelId: string,
  reasoningEffort: ReasoningEffort,
): Record<string, unknown> {
  const selection = splitTaskModelId(modelId);
  const options = buildOpenCodeModelReasoningOptions(modelId, reasoningEffort);

  if (!selection || !options) {
    return providerConfig;
  }

  const providerEntry =
    providerConfig[selection.providerID] &&
    typeof providerConfig[selection.providerID] === 'object' &&
    !Array.isArray(providerConfig[selection.providerID])
      ? (providerConfig[selection.providerID] as Record<string, unknown>)
      : {};
  const models =
    providerEntry.models &&
    typeof providerEntry.models === 'object' &&
    !Array.isArray(providerEntry.models)
      ? (providerEntry.models as Record<string, unknown>)
      : {};

  if (models[selection.modelID]) {
    return providerConfig;
  }

  return {
    ...providerConfig,
    [selection.providerID]: {
      ...providerEntry,
      models: {
        ...models,
        [selection.modelID]: { options },
      },
    },
  };
}
