/**
 * A curated model a provider is known to serve. These are the recommended
 * models auto-added when the provider is connected and always listed for
 * connected providers on the models settings page, so operators land on a
 * usable model list without knowing model slugs. `id` is the full task model
 * id including the model-id prefix (which is `openai/` for the ChatGPT
 * subscription provider, not `chatgpt/`).
 */
export type SuggestedTaskModel = {
  id: string;
  displayName: string;
  family?: string;
};

type RecommendedTaskModel = {
  /** Stable provider-agnostic key, referenced by per-provider slug maps. */
  id: string;
  displayName: string;
  family: string;
};

/**
 * The centralized list of recommended task models. Display names, families,
 * and ordering are defined once here; each inference provider maps the
 * models it serves to its own slug (`mapRecommendedTaskModels` in the setup
 * provider catalog), and the default OpenRouter task model catalog derives
 * from the same list. Release-based by design: editing this list and the
 * per-provider slug maps is how the recommended set changes.
 */
export const RECOMMENDED_TASK_MODELS = [
  { id: 'claude-fable-5', displayName: 'Claude Fable 5', family: 'Fable' },
  { id: 'claude-haiku-4-5', displayName: 'Claude Haiku 4.5', family: 'Haiku' },
  { id: 'claude-opus-5', displayName: 'Claude Opus 5', family: 'Opus' },
  { id: 'claude-sonnet-5', displayName: 'Claude Sonnet 5', family: 'Sonnet' },
  { id: 'gpt-5-6-sol', displayName: 'GPT 5.6 Sol', family: 'GPT' },
  { id: 'gpt-5-6-terra', displayName: 'GPT 5.6 Terra', family: 'GPT' },
  { id: 'gpt-5-6-luna', displayName: 'GPT 5.6 Luna', family: 'GPT' },
  {
    id: 'gemini-3-6-flash',
    displayName: 'Gemini 3.6 Flash',
    family: 'Gemini',
  },
  {
    id: 'gemini-3-7-flash',
    displayName: 'Gemini 3.7 Flash',
    family: 'Gemini',
  },
  {
    id: 'deepseek-v4-flash-0731',
    displayName: 'DeepSeek V4 Flash 0731',
    family: 'DeepSeek',
  },
  {
    id: 'deepseek-v4-pro-0813',
    displayName: 'DeepSeek V4 Pro 0813',
    family: 'DeepSeek',
  },
  { id: 'glm-5-2', displayName: 'GLM 5.2', family: 'GLM' },
  { id: 'kimi-k3', displayName: 'Kimi K3', family: 'Kimi' },
  { id: 'kimi-k2-7-code', displayName: 'Kimi K2.7 Code', family: 'Kimi' },
  { id: 'qwen3-8-max', displayName: 'Qwen3.8 Max', family: 'Qwen' },
  { id: 'minimax-m3', displayName: 'MiniMax M3', family: 'Minimax' },
  { id: 'grok-4-6', displayName: 'Grok 4.6', family: 'Grok' },
] as const satisfies readonly RecommendedTaskModel[];

export type RecommendedTaskModelId =
  (typeof RECOMMENDED_TASK_MODELS)[number]['id'];

/**
 * A provider's mapping from centralized recommended models to the full task
 * model ids it serves them under. Models a provider does not serve are
 * simply omitted.
 */
export type RecommendedTaskModelSlugMap = Partial<
  Record<RecommendedTaskModelId, string>
>;

/**
 * Resolves a provider's slug map against the centralized recommended list,
 * in the centralized order, carrying the shared display name and family.
 */
export function mapRecommendedTaskModels(
  slugByModel: RecommendedTaskModelSlugMap,
): RecommendedTaskModel[] {
  return RECOMMENDED_TASK_MODELS.flatMap((model) => {
    const id = slugByModel[model.id];

    return id
      ? [{ id, displayName: model.displayName, family: model.family }]
      : [];
  });
}

/**
 * OpenRouter's slug map is shared: it defines both the OpenRouter provider's
 * recommended models and the default task model catalog a fresh deployment
 * starts from (OpenRouter is the default setup provider and routes every
 * lab in the recommended list).
 */
export const OPENROUTER_RECOMMENDED_TASK_MODEL_SLUGS = {
  'claude-fable-5': 'openrouter/anthropic/claude-fable-5',
  'claude-haiku-4-5': 'openrouter/anthropic/claude-haiku-4.5',
  'claude-opus-5': 'openrouter/anthropic/claude-opus-5',
  'claude-sonnet-5': 'openrouter/anthropic/claude-sonnet-5',
  'gpt-5-6-sol': 'openrouter/openai/gpt-5.6-sol',
  'gpt-5-6-terra': 'openrouter/openai/gpt-5.6-terra',
  'gpt-5-6-luna': 'openrouter/openai/gpt-5.6-luna',
  'gemini-3-7-flash': 'openrouter/google/gemini-3.7-flash',
  'deepseek-v4-flash-0731': 'openrouter/deepseek/deepseek-v4-flash-0731',
  'deepseek-v4-pro-0813': 'openrouter/deepseek/deepseek-v4-pro-0813',
  'glm-5-2': 'openrouter/z-ai/glm-5.2',
  'kimi-k3': 'openrouter/moonshotai/kimi-k3',
  'kimi-k2-7-code': 'openrouter/moonshotai/kimi-k2.7-code',
  'qwen3-8-max': 'openrouter/qwen/qwen3.8-max',
  'minimax-m3': 'openrouter/minimax/minimax-m3',
  'grok-4-6': 'openrouter/x-ai/grok-4.6',
} as const satisfies RecommendedTaskModelSlugMap;
