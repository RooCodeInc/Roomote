import { z } from 'zod';

import {
  OPENROUTER_RECOMMENDED_TASK_MODEL_SLUGS,
  mapRecommendedTaskModels,
} from './recommended-task-models';
import { isOpenAiCompatibleProviderId } from './openai-compatible-providers';

const TASK_MODEL_ID_PATTERN = /^[^/\s]+\/.+$/u;

/**
 * Model providers whose slugs are addressed by their own provider prefix
 * instead of the `openrouter/` shorthand: direct labs plus non-OpenRouter
 * gateways such as Vercel AI Gateway. Bare `provider/model` slugs with one of
 * these prefixes are kept as-is instead of being rewritten to OpenRouter.
 * Setup providers derive from the enabled subset plus `openrouter`; disabled
 * prefixes remain in the combined list only for persisted-id compatibility.
 */
export const ENABLED_DIRECT_TASK_MODEL_PROVIDER_IDS = [
  'vercel',
  'requesty',
  'baseten',
  'togetherai',
  'openai',
  'azure',
  'azure-cognitive-services',
  'anthropic',
  'moonshotai',
  'kimi-for-coding',
  'minimax',
  'opencode',
  'opencode-go',
  'amazon-bedrock',
  'google',
  'xai',
  'zai',
  'zai-coding-plan',
  'github-copilot',
  'openai-compatible',
  'litellm',
  'ollama',
  'vllm',
] as const;

/**
 * Provider prefixes retained only so persisted model ids keep their original
 * shape while support is disabled. They are excluded from setup, model
 * availability, and runtime selection.
 */
export const DISABLED_TASK_MODEL_PROVIDER_IDS = [
  'google-vertex',
  'mistral',
] as const;

export const DIRECT_TASK_MODEL_PROVIDER_IDS = [
  ...ENABLED_DIRECT_TASK_MODEL_PROVIDER_IDS,
  ...DISABLED_TASK_MODEL_PROVIDER_IDS,
] as const;

const DIRECT_TASK_MODEL_PROVIDER_ID_SET = new Set<string>([
  ...DIRECT_TASK_MODEL_PROVIDER_IDS,
  'bedrock-mantle',
]);

const DISABLED_TASK_MODEL_PROVIDER_ID_SET = new Set<string>(
  DISABLED_TASK_MODEL_PROVIDER_IDS,
);

/**
 * Gateway providers route models from many labs under a single provider
 * prefix (e.g. `openrouter/z-ai/glm-5.2`, `vercel/openai/gpt-5.6-terra`,
 * `requesty/claude-sonnet-5`). This is the canonical set:
 * models.dev slug resolution and gateway pricing lookups derive from it.
 * `vercel` and `requesty` also appear in `DIRECT_TASK_MODEL_PROVIDER_IDS`
 * because their slugs are addressed by their own prefix; `openrouter` is the
 * fallback prefix for bare `provider/model` slugs instead.
 */
export const GATEWAY_TASK_MODEL_PROVIDER_IDS = [
  'openrouter',
  'vercel',
  'requesty',
  'baseten',
  'togetherai',
] as const;

export const TASK_MODEL_INPUT_TYPES = [
  'text',
  'image',
  'video',
  'sound',
  'pdf',
] as const;

export type TaskModelInputType = (typeof TASK_MODEL_INPUT_TYPES)[number];

export const taskModelMetadataSchema = z.object({
  contextWindow: z.number().int().positive().nullable(),
  inputTypes: z.array(z.enum(TASK_MODEL_INPUT_TYPES)).nullable(),
  inputPricePerToken: z.number().nonnegative().nullable(),
  outputPricePerToken: z.number().nonnegative().nullable(),
  lastRefreshedAt: z.string().datetime().nullable(),
  /**
   * Whether the model supports a configurable reasoning effort, sourced from
   * the models.dev `reasoning` flag or the OpenRouter `supported_parameters`
   * list. Absent or null when the catalogs do not say either way.
   */
  supportsReasoning: z.boolean().nullable().optional(),
});

export type TaskModelMetadata = z.infer<typeof taskModelMetadataSchema>;

export const taskModelOptionSchema = z.object({
  id: z
    .string()
    .trim()
    .min(1)
    .regex(
      TASK_MODEL_ID_PATTERN,
      'Task model IDs must use provider/model format.',
    ),
  displayName: z.string().trim().min(1),
  family: z.string().trim().min(1),
  metadata: taskModelMetadataSchema.nullable().optional(),
});

export type TaskModelOption = z.infer<typeof taskModelOptionSchema>;

function sortTaskModelOptionsById<T extends { id: string }>(models: T[]): T[] {
  return [...models].sort((left, right) =>
    left.id.localeCompare(right.id, undefined, {
      sensitivity: 'base',
      numeric: true,
    }),
  );
}

/**
 * The default task model catalog a deployment starts from before any model
 * settings are persisted: the centralized recommended list routed through
 * OpenRouter, the default setup provider.
 */
export const TASK_MODEL_CATALOG: readonly TaskModelOption[] =
  mapRecommendedTaskModels(OPENROUTER_RECOMMENDED_TASK_MODEL_SLUGS);

export const DEFAULT_TASK_MODEL_ID = 'openrouter/openai/gpt-5.6-terra';
const LEGACY_DEFAULT_TASK_MODEL_ID = 'roomote-model-default';

const TASK_MODEL_CATALOG_BY_ID = new Map<string, TaskModelOption>(
  TASK_MODEL_CATALOG.map((option) => [option.id, option]),
);

const TASK_MODEL_FAMILY_ALIASES = {
  Fable: ['fable'],
  Haiku: ['haiku'],
  Sonnet: ['sonnet'],
  Opus: ['opus'],
  GPT: ['gpt'],
  Gemini: ['gemini'],
  GLM: ['glm'],
  MiMo: ['mimo'],
  Minimax: ['minimax'],
  Kimi: ['kimi'],
  DeepSeek: ['deepseek'],
  Qwen: ['qwen'],
  Grok: ['grok'],
} as const satisfies Record<string, readonly string[]>;

export const taskModelSettingsSchema = z.object({
  models: z.array(taskModelOptionSchema).optional(),
  allowedModelIds: z.array(z.string().trim().min(1)),
  defaultModelId: z.string().trim().min(1),
});

export type TaskModelSettings = z.infer<typeof taskModelSettingsSchema>;

export const DEFAULT_TASK_MODEL_SETTINGS: TaskModelSettings = {
  models: sortTaskModelOptionsById([...TASK_MODEL_CATALOG]),
  allowedModelIds: sortTaskModelOptionsById([...TASK_MODEL_CATALOG]).map(
    (option) => option.id,
  ),
  defaultModelId: DEFAULT_TASK_MODEL_ID,
};

function getFallbackTaskModelFamily(
  modelId: string,
  displayName?: string,
): string {
  const displayNameToken = displayName?.trim().match(/[A-Za-z0-9]+/u)?.[0];

  if (displayNameToken) {
    return displayNameToken;
  }

  const modelSuffix = modelId.split('/').at(-1) ?? modelId;
  const [familyToken] =
    modelSuffix.match(/[a-z0-9]+/giu)?.filter(Boolean) ?? [];

  if (!familyToken) {
    return 'Custom';
  }

  return familyToken.charAt(0).toUpperCase() + familyToken.slice(1);
}

/**
 * Returns the provider prefix of a task model id, such as `openrouter` or
 * `anthropic`, or `null` when the id has no provider segment.
 */
export function getTaskModelProviderId(modelId: string): string | null {
  const [providerId] = modelId.trim().split('/');
  return providerId || null;
}

/** True when a model belongs to a provider Roomote currently refuses to run. */
export function isTaskModelIdDisabled(modelId: string): boolean {
  const providerId = getTaskModelProviderId(modelId);

  return providerId
    ? DISABLED_TASK_MODEL_PROVIDER_ID_SET.has(providerId)
    : false;
}

const TASK_MODEL_ID_ALIASES: Readonly<Record<string, string>> = {
  // OpenCode Zen serves this dated release through an undated stable alias.
  'opencode/deepseek-v4-flash-0731': 'opencode/deepseek-v4-flash',
};

/** Rewrites model IDs that Roomote persisted before a provider slug changed. */
export function resolveTaskModelIdAlias(modelId: string): string {
  return TASK_MODEL_ID_ALIASES[modelId] ?? modelId;
}

export function normalizeTaskModelId(modelId: string): string {
  const trimmedModelId = resolveTaskModelIdAlias(modelId.trim());

  if (
    trimmedModelId &&
    !trimmedModelId.startsWith('openrouter/') &&
    trimmedModelId.split('/').length === 2 &&
    !DIRECT_TASK_MODEL_PROVIDER_ID_SET.has(trimmedModelId.split('/')[0]!) &&
    !isOpenAiCompatibleProviderId(trimmedModelId.split('/')[0]!)
  ) {
    return `openrouter/${trimmedModelId}`;
  }

  return trimmedModelId;
}

/**
 * When LiteLLM is configured, bare OpenCode model names without a provider
 * segment are treated as LiteLLM route names and rewritten to
 * `litellm/<name>`. Explicit `provider/model` ids (including already-prefixed
 * `litellm/...` values) are left unchanged.
 */
export function applyImplicitLiteLlmModelPrefix(
  modelId: string,
  isLiteLlmConfigured: boolean,
): string {
  const trimmedModelId = modelId.trim();

  if (!trimmedModelId || !isLiteLlmConfigured || trimmedModelId.includes('/')) {
    return trimmedModelId;
  }

  return `litellm/${trimmedModelId}`;
}

export function buildTaskModelOption(input: {
  id: string;
  displayName: string;
  family?: string | null | undefined;
  metadata?: TaskModelMetadata | null | undefined;
}): TaskModelOption {
  const normalizedId = normalizeTaskModelId(input.id);
  const normalizedDisplayName = input.displayName.trim();
  const normalizedFamily = input.family?.trim();

  const option: {
    id: string;
    displayName: string;
    family: string;
    metadata?: TaskModelMetadata | null;
  } = {
    id: normalizedId,
    displayName: normalizedDisplayName,
    family:
      normalizedFamily && normalizedFamily.length > 0
        ? normalizedFamily
        : getFallbackTaskModelFamily(normalizedId, normalizedDisplayName),
  };

  if (input.metadata !== undefined) {
    option.metadata = input.metadata ?? null;
  }

  return taskModelOptionSchema.parse(option);
}

function normalizeTaskModelCatalog(
  models: readonly TaskModelOption[] | undefined,
): TaskModelOption[] {
  const sourceModels = models?.length
    ? models
    : (DEFAULT_TASK_MODEL_SETTINGS.models ?? TASK_MODEL_CATALOG);
  const byId = new Map<string, TaskModelOption>();

  for (const model of sourceModels) {
    const normalizedModel = buildTaskModelOption(model);

    if (isTaskModelIdDisabled(normalizedModel.id)) {
      continue;
    }

    byId.set(normalizedModel.id, normalizedModel);
  }

  const normalizedModels = sortTaskModelOptionsById([...byId.values()]);

  return normalizedModels.length > 0
    ? normalizedModels
    : sortTaskModelOptionsById([...TASK_MODEL_CATALOG]);
}

export function getTaskModelCatalog(
  settings: TaskModelSettings | null | undefined,
): TaskModelOption[] {
  return normalizeTaskModelSettings(settings).models ?? [];
}

function normalizeTaskModelMatchText(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

function getNormalizedPhraseMatchIndex(
  haystack: string,
  phrase: string,
): number | undefined {
  if (!haystack || !phrase) {
    return undefined;
  }

  const match = new RegExp(`(^| )${escapeRegExp(phrase)}(?=$| )`, 'u').exec(
    haystack,
  );

  if (!match) {
    return undefined;
  }

  return match.index + (match[1]?.length ?? 0);
}

function normalizedTextContainsPhrase(
  haystack: string,
  phrase: string,
): boolean {
  return getNormalizedPhraseMatchIndex(haystack, phrase) !== undefined;
}

function hasTaskModelFamilyIntent(
  normalizedText: string,
  family: string,
): boolean {
  const normalizedFamily = normalizeTaskModelMatchText(family);

  if (!normalizedFamily) {
    return false;
  }

  if (normalizedText === normalizedFamily) {
    return true;
  }

  return [
    `use ${normalizedFamily}`,
    `with ${normalizedFamily}`,
    `go with ${normalizedFamily}`,
    `choose ${normalizedFamily}`,
    `pick ${normalizedFamily}`,
    `select ${normalizedFamily}`,
    `prefer ${normalizedFamily}`,
    `using ${normalizedFamily}`,
    `run on ${normalizedFamily}`,
    `${normalizedFamily} please`,
    `${normalizedFamily} for this`,
    `${normalizedFamily} for this one`,
    `${normalizedFamily} thanks`,
    `${normalizedFamily} thank you`,
  ].some((phrase) => normalizedTextContainsPhrase(normalizedText, phrase));
}

function getNormalizedTaskModelSearchTerms(option: TaskModelOption): string[] {
  const openRouterSuffix = option.id.startsWith('openrouter/')
    ? option.id.slice('openrouter/'.length)
    : option.id;

  return [option.displayName, option.id, openRouterSuffix].map(
    normalizeTaskModelMatchText,
  );
}

function getTaskModelFamilyAliases(family: string): readonly string[] {
  return (
    TASK_MODEL_FAMILY_ALIASES[
      family as keyof typeof TASK_MODEL_FAMILY_ALIASES
    ] ?? [family]
  );
}

export function getTaskModelOptionById(
  modelId: string | null | undefined,
  settings?: TaskModelSettings | null | undefined,
): TaskModelOption | undefined {
  if (!modelId) {
    return undefined;
  }

  const normalizedModelId = normalizeTaskModelId(modelId);

  if (!settings) {
    return TASK_MODEL_CATALOG_BY_ID.get(normalizedModelId);
  }

  return getTaskModelCatalog(settings).find(
    (option) => option.id === normalizedModelId,
  );
}

export function getTaskModelDisplayName(
  modelId: string,
  settings?: TaskModelSettings | null | undefined,
): string {
  if (modelId === LEGACY_DEFAULT_TASK_MODEL_ID) {
    return 'Default model (legacy)';
  }

  return getTaskModelOptionById(modelId, settings)?.displayName ?? modelId;
}

export function normalizeTaskModelSettings(value: unknown): TaskModelSettings {
  const parsed = taskModelSettingsSchema.safeParse(value);
  const models = normalizeTaskModelCatalog(
    parsed.success ? parsed.data.models : undefined,
  );
  const modelIds = new Set(models.map((model) => model.id));
  const allowedModelIds = [
    ...new Set(
      (parsed.success
        ? parsed.data.allowedModelIds
        : DEFAULT_TASK_MODEL_SETTINGS.allowedModelIds
      )
        .map(normalizeTaskModelId)
        .filter((modelId) => modelIds.has(modelId)),
    ),
  ];

  const nextAllowedModelIds =
    allowedModelIds.length > 0
      ? allowedModelIds
      : models.length > 0
        ? [models[0]!.id]
        : [...DEFAULT_TASK_MODEL_SETTINGS.allowedModelIds];

  const requestedDefaultModelId = parsed.success
    ? normalizeTaskModelId(parsed.data.defaultModelId)
    : DEFAULT_TASK_MODEL_SETTINGS.defaultModelId;
  const defaultModelId = nextAllowedModelIds.includes(requestedDefaultModelId)
    ? requestedDefaultModelId
    : (nextAllowedModelIds[0] ?? DEFAULT_TASK_MODEL_SETTINGS.defaultModelId);

  return {
    models,
    allowedModelIds: nextAllowedModelIds,
    defaultModelId,
  };
}

export function getEnabledTaskModels(
  settings: TaskModelSettings | null | undefined,
): TaskModelOption[] {
  const normalized = normalizeTaskModelSettings(settings);

  return normalized.allowedModelIds
    .map((modelId) => getTaskModelOptionById(modelId, normalized))
    .filter((option): option is TaskModelOption => option !== undefined);
}

export function getDefaultTaskModelId(
  settings: TaskModelSettings | null | undefined,
): string {
  return normalizeTaskModelSettings(settings).defaultModelId;
}

export function getDefaultTaskModel(
  settings: TaskModelSettings | null | undefined,
): TaskModelOption {
  const normalized = normalizeTaskModelSettings(settings);
  const defaultModelId = getDefaultTaskModelId(settings);

  return (
    getTaskModelOptionById(defaultModelId, normalized) ??
    TASK_MODEL_CATALOG_BY_ID.get(DEFAULT_TASK_MODEL_ID) ??
    normalized.models?.[0] ??
    // The catalog derives from the recommended list, which is never empty.
    TASK_MODEL_CATALOG[0]!
  );
}

export function isTaskModelIdAllowed(
  settings: TaskModelSettings | null | undefined,
  modelId: string,
): boolean {
  return normalizeTaskModelSettings(settings).allowedModelIds.includes(modelId);
}

export function resolveRequestedTaskModelIdFromText(options: {
  text: string;
  settings: TaskModelSettings | null | undefined;
}): string | undefined {
  const normalizedText = normalizeTaskModelMatchText(options.text);

  if (!normalizedText) {
    return undefined;
  }

  const enabledModels = getEnabledTaskModels(options.settings);
  const exactMatch = enabledModels.find((option) =>
    getNormalizedTaskModelSearchTerms(option).some((term) =>
      normalizedTextContainsPhrase(normalizedText, term),
    ),
  );

  if (exactMatch) {
    return exactMatch.id;
  }

  const familyMatches = enabledModels
    .map((option) => ({
      option,
      index: getTaskModelFamilyAliases(option.family)
        .flatMap((alias) => {
          const index = getNormalizedPhraseMatchIndex(
            normalizedText,
            normalizeTaskModelMatchText(alias),
          );

          return index === undefined ? [] : [index];
        })
        .sort((left, right) => left - right)[0],
    }))
    .filter(
      (match): match is { option: TaskModelOption; index: number } =>
        typeof match.index === 'number',
    )
    .filter(({ option }) =>
      hasTaskModelFamilyIntent(normalizedText, option.family),
    )
    .sort((left, right) => left.index - right.index);

  if (familyMatches.length === 0) {
    return undefined;
  }

  const selectedFamily = familyMatches[0]?.option.family;
  const highestVersionMatch = enabledModels
    .filter((option) => option.family === selectedFamily)
    .sort((left, right) =>
      right.displayName.localeCompare(left.displayName, undefined, {
        numeric: true,
        sensitivity: 'base',
      }),
    )[0];

  return highestVersionMatch?.id;
}

/**
 * Runtime env var carrying the comma-separated model IDs a running task may
 * switch to without regenerating its OpenCode config. The control plane only
 * lists models whose provider credentials the sandbox can already reach, so
 * the worker can treat membership as authoritative.
 */
export const SWITCHABLE_MODELS_ENV_VAR_NAME = 'R_SWITCHABLE_MODELS';

/**
 * Upper bound on the advertised switchable set. A very large enabled catalog
 * should not bloat every task's runtime env and generated provider config.
 */
export const MAX_SWITCHABLE_MODEL_IDS = 100;

/** Parse the comma-separated `R_SWITCHABLE_MODELS` value into a list. */
export function parseSwitchableModelIds(
  value: string | undefined | null,
): string[] {
  return [
    ...new Set(
      (value ?? '')
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
    ),
  ];
}
