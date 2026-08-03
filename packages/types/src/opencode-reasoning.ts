import type { ReasoningEffort } from './task-runs';

/**
 * Maps a Roomote reasoning effort to the Anthropic extended-thinking token
 * budgets OpenCode uses for its own built-in variants (`high` ~16k tokens,
 * `max` ~32k tokens). Only applies to models predating adaptive thinking —
 * see `resolveAnthropicThinkingMode`.
 */
const ANTHROPIC_THINKING_BUDGET_TOKENS: Record<ReasoningEffort, number> = {
  low: 4_000,
  medium: 8_000,
  high: 16_000,
  xhigh: 31_999,
  max: 31_999,
};

/**
 * How an Anthropic model expects reasoning to be configured:
 *
 * - `adaptive` — Opus 4.7+, Sonnet 5+, and Fable/Mythos reject
 *   `thinking.type: "enabled"` with a 400 and take
 *   `thinking.type: "adaptive"` plus an `effort` (including `xhigh`). These
 *   models also default thinking display to "omitted" (empty thinking
 *   blocks), so we force `display: "summarized"`.
 * - `adaptive-no-xhigh` — the 4.6 family accepts adaptive thinking but not
 *   the `xhigh` effort, and already defaults display to "summarized".
 * - `budget` — older models (Sonnet 4.5, Haiku 4.5, Opus 4.5, ...) still use
 *   `thinking.type: "enabled"` with a token budget.
 */
type AnthropicThinkingMode = 'adaptive' | 'adaptive-no-xhigh' | 'budget';

/**
 * Parses the `<family>-<major>[-<minor>]` version out of an Anthropic model
 * id, accepting `.` or `-` separators, dated suffixes
 * (`claude-sonnet-4-5-20250929`), Bedrock's `anthropic.` prefix, and the
 * inverted legacy ordering (`claude-3-5-sonnet`).
 */
function parseAnthropicModelVersion(
  modelID: string,
  family: 'opus' | 'sonnet',
): { major: number; minor: number } | null {
  const pattern = new RegExp(
    `${family}-(\\d+)(?:[.-](\\d+))?(?:[.@-]|$)|claude-(\\d+)(?:[.-](\\d+))?-${family}(?:[.@-]|$)`,
    'iu',
  );
  const match = pattern.exec(modelID);

  if (!match) {
    return null;
  }

  return {
    major: Number(match[1] ?? match[3]),
    minor: Number(match[2] ?? match[4] ?? 0),
  };
}

function resolveAnthropicThinkingMode(modelID: string): AnthropicThinkingMode {
  const id = modelID.toLowerCase();

  if (id.includes('fable') || id.includes('mythos')) {
    return 'adaptive';
  }

  const opus = parseAnthropicModelVersion(id, 'opus');

  if (opus) {
    if (opus.major > 4 || (opus.major === 4 && opus.minor >= 7)) {
      return 'adaptive';
    }

    return opus.major === 4 && opus.minor === 6
      ? 'adaptive-no-xhigh'
      : 'budget';
  }

  const sonnet = parseAnthropicModelVersion(id, 'sonnet');

  if (sonnet) {
    if (sonnet.major >= 5) {
      return 'adaptive';
    }

    return sonnet.major === 4 && sonnet.minor === 6
      ? 'adaptive-no-xhigh'
      : 'budget';
  }

  return 'budget';
}

function buildAnthropicReasoningOptions(
  modelID: string,
  reasoningEffort: ReasoningEffort,
): Record<string, unknown> {
  const mode = resolveAnthropicThinkingMode(modelID);

  if (mode === 'budget') {
    return {
      thinking: {
        type: 'enabled',
        budgetTokens: ANTHROPIC_THINKING_BUDGET_TOKENS[reasoningEffort],
      },
    };
  }

  return {
    thinking: {
      type: 'adaptive',
      ...(mode === 'adaptive' ? { display: 'summarized' } : {}),
    },
    effort:
      mode === 'adaptive-no-xhigh' && reasoningEffort === 'xhigh'
        ? 'high'
        : reasoningEffort,
  };
}

function buildAmazonBedrockReasoningOptions(
  modelID: string,
  reasoningEffort: ReasoningEffort,
): Record<string, unknown> | null {
  const normalizedModelID = modelID.toLowerCase();

  if (normalizedModelID.includes('anthropic.')) {
    const mode = resolveAnthropicThinkingMode(modelID);

    if (mode === 'budget') {
      return {
        reasoningConfig: {
          type: 'enabled',
          budgetTokens: ANTHROPIC_THINKING_BUDGET_TOKENS[reasoningEffort],
        },
      };
    }

    return {
      reasoningConfig: {
        type: 'adaptive',
        maxReasoningEffort:
          mode === 'adaptive-no-xhigh' && reasoningEffort === 'xhigh'
            ? 'high'
            : reasoningEffort,
        ...(mode === 'adaptive' ? { display: 'summarized' } : {}),
      },
    };
  }

  if (normalizedModelID.includes('amazon.nova')) {
    return {
      reasoningConfig: {
        type: 'enabled',
        maxReasoningEffort:
          reasoningEffort === 'low' || reasoningEffort === 'medium'
            ? reasoningEffort
            : 'high',
      },
    };
  }

  return null;
}

function buildGitHubCopilotReasoningOptions(
  modelID: string,
  reasoningEffort: ReasoningEffort,
): Record<string, unknown> {
  // Copilot exposes older Claude models through its OpenAI-compatible chat
  // endpoint, where extended thinking is configured with the provider's
  // snake_case `thinking_budget` option. Newer Copilot models expose effort
  // directly and continue to use `reasoningEffort`.
  if (
    modelID.toLowerCase().includes('claude') &&
    resolveAnthropicThinkingMode(modelID) === 'budget'
  ) {
    return {
      thinking_budget: ANTHROPIC_THINKING_BUDGET_TOKENS[reasoningEffort],
    };
  }

  return { reasoningEffort };
}

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
 * variants: OpenRouter takes `reasoning.effort`, Anthropic takes adaptive
 * thinking with an effort (or an extended-thinking budget on models
 * predating adaptive thinking), and OpenAI-compatible providers take
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

  if (selection.providerID === 'amazon-bedrock') {
    return buildAmazonBedrockReasoningOptions(
      selection.modelID,
      reasoningEffort,
    );
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
    case 'bedrock-mantle':
      return buildAnthropicReasoningOptions(selection.modelID, reasoningEffort);
    case 'github-copilot':
      return buildGitHubCopilotReasoningOptions(
        selection.modelID,
        reasoningEffort,
      );
    case 'litellm':
      // LiteLLM's OpenAI-compatible endpoint rejects `xhigh`; keep the
      // highest accepted setting instead of failing the inference request.
      return {
        reasoningEffort: reasoningEffort === 'xhigh' ? 'high' : reasoningEffort,
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
