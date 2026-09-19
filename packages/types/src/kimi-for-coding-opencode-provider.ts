/**
 * Kimi for Coding OpenCode wiring shared by the task worker and the non-task
 * helper servers.
 *
 * OpenCode resolves a provider's SDK package and base URL from the models.dev
 * catalog it refreshes at runtime, keyed by provider id. That catalog renamed
 * `kimi-for-coding` (to `kimi-code-plan-cn` / `kimi-code-plan-global`), which
 * left Roomote's `kimi-for-coding/...` model ids pointing at a provider the
 * catalog no longer knows. A config that only carries per-model options for
 * an unknown provider makes OpenCode fall back to `@ai-sdk/openai-compatible`
 * with an empty base URL, so every request failed before it was sent.
 *
 * Roomote owns this provider id, its credential env var, and its inference
 * gateway route, so it registers the full provider definition itself instead
 * of depending on the catalog entry existing.
 */

export const KIMI_FOR_CODING_OPENCODE_PROVIDER_ID = 'kimi-for-coding';

/**
 * api.kimi.com/coding serves both the Anthropic Messages surface and an
 * OpenAI-compatible one. Roomote stays on Messages: it is the surface the
 * inference gateway route allows and authenticates (`x-api-key`), and it
 * round-trips reasoning natively through thinking blocks.
 */
const KIMI_FOR_CODING_NPM_PACKAGE = '@ai-sdk/anthropic';
const KIMI_FOR_CODING_API_URL = 'https://api.kimi.com/coding/v1';
const KIMI_FOR_CODING_API_KEY_ENV_VAR_NAME = 'KIMI_API_KEY';

type KimiForCodingModelDefinition = {
  name: string;
  family: string;
  release_date: string;
  attachment: boolean;
  reasoning: boolean;
  temperature: boolean;
  tool_call: boolean;
  modalities: { input: string[]; output: string[] };
  limit: { context: number; output: number };
};

/**
 * The model ids Kimi documents for this endpoint. Unofficial ids are rejected
 * or silently routed to the default model, so only these carry metadata.
 * Costs stay unset: membership keys are billed by subscription, not tokens.
 */
const KIMI_FOR_CODING_MODELS: Readonly<
  Record<string, KimiForCodingModelDefinition>
> = {
  k3: {
    name: 'Kimi K3',
    family: 'kimi-k3',
    release_date: '2026-07-16',
    attachment: true,
    reasoning: true,
    temperature: false,
    tool_call: true,
    modalities: { input: ['text', 'image', 'video'], output: ['text'] },
    limit: { context: 1_048_576, output: 131_072 },
  },
  'k3-256k': {
    name: 'Kimi K3-256K',
    family: 'kimi-k3',
    release_date: '2026-07-16',
    attachment: true,
    reasoning: true,
    temperature: false,
    tool_call: true,
    modalities: { input: ['text', 'image'], output: ['text'] },
    limit: { context: 262_144, output: 131_072 },
  },
  'kimi-for-coding': {
    name: 'Kimi for Coding',
    family: 'kimi-k2',
    release_date: '2026-09-11',
    attachment: true,
    reasoning: true,
    temperature: false,
    tool_call: true,
    modalities: { input: ['text', 'image', 'video'], output: ['text'] },
    limit: { context: 1_048_576, output: 32_768 },
  },
  'kimi-for-coding-highspeed': {
    name: 'Kimi for Coding HighSpeed',
    family: 'kimi-k2',
    release_date: '2026-06-12',
    attachment: true,
    reasoning: true,
    temperature: false,
    tool_call: true,
    modalities: { input: ['text', 'image', 'video'], output: ['text'] },
    limit: { context: 262_144, output: 32_768 },
  },
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

function collectKimiForCodingModelIds(
  modelIds: Array<string | undefined>,
): string[] {
  const prefix = `${KIMI_FOR_CODING_OPENCODE_PROVIDER_ID}/`;

  return [
    ...new Set(
      modelIds.flatMap((modelId) => {
        const normalized = modelId?.trim();

        return normalized?.startsWith(prefix) &&
          normalized.length > prefix.length
          ? [normalized.slice(prefix.length)]
          : [];
      }),
    ),
  ];
}

/**
 * Registers the complete Kimi for Coding provider (SDK package, base URL,
 * credential env var, and model entries) whenever a selected model uses it.
 * Existing provider and per-model config — reasoning options, an operator
 * override, the gateway rebase applied afterwards — always wins over these
 * defaults.
 */
export function mergeKimiForCodingProviderConfig(
  providerConfig: Record<string, unknown>,
  modelIds: Array<string | undefined>,
): Record<string, unknown> {
  const selectedModelIds = collectKimiForCodingModelIds(modelIds);

  if (selectedModelIds.length === 0) {
    return providerConfig;
  }

  const existingProvider = asRecord(
    providerConfig[KIMI_FOR_CODING_OPENCODE_PROVIDER_ID],
  );
  const existingModels = asRecord(existingProvider.models);
  // Known ids are always registered so switching between them mid-session
  // resolves; a selected id Kimi added later still gets a usable entry.
  const registeredModelIds = [
    ...new Set([...Object.keys(KIMI_FOR_CODING_MODELS), ...selectedModelIds]),
  ];

  return {
    ...providerConfig,
    [KIMI_FOR_CODING_OPENCODE_PROVIDER_ID]: {
      npm: KIMI_FOR_CODING_NPM_PACKAGE,
      name: 'Kimi for Coding',
      api: KIMI_FOR_CODING_API_URL,
      env: [KIMI_FOR_CODING_API_KEY_ENV_VAR_NAME],
      ...existingProvider,
      models: {
        ...existingModels,
        ...Object.fromEntries(
          registeredModelIds.map((modelId) => [
            modelId,
            {
              ...(KIMI_FOR_CODING_MODELS[modelId] ?? { name: modelId }),
              ...asRecord(existingModels[modelId]),
            },
          ]),
        ),
      },
    },
  };
}
