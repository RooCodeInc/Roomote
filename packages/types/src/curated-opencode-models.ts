/**
 * Runtime definitions for curated routes that are not yet in OpenCode's
 * catalog. Shared by task and helper config builders so role-only selections
 * resolve without depending on reasoning options to register the model.
 */
const GPT_61_TERRA = {
  name: 'GPT-6.1 Terra',
  family: 'gpt-terra',
  release_date: '2026-10-26',
  attachment: true,
  reasoning: true,
  temperature: false,
  tool_call: true,
  modalities: { input: ['text', 'image'], output: ['text'] },
  limit: { context: 1_050_000, input: 922_000, output: 128_000 },
};

// Capabilities/limits: https://developers.openai.com/api/docs/models/gpt-6.1-terra
// Azure: https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/models-sold-directly-by-azure#gpt-61
// Requesty route: https://router.requesty.ai/v1/models
const CURATED_OPENCODE_MODELS = {
  'requesty/azure/gpt-6.1-terra@swedencentral': GPT_61_TERRA,
  'azure/gpt-6.1-terra': GPT_61_TERRA,
  'azure-cognitive-services/gpt-6.1-terra': GPT_61_TERRA,
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Fill known model defaults without changing SDKs, credentials or overrides. */
export function mergeCuratedOpenCodeModelConfig(
  providerConfig: Record<string, unknown>,
  modelIds: Array<string | undefined>,
): Record<string, unknown> {
  let merged = providerConfig;
  const selectedIds = new Set(modelIds.map((modelId) => modelId?.trim()));

  for (const [id, definition] of Object.entries(CURATED_OPENCODE_MODELS)) {
    if (!selectedIds.has(id)) continue;

    const separator = id.indexOf('/');
    const providerId = id.slice(0, separator);
    const modelId = id.slice(separator + 1);
    const provider = asRecord(merged[providerId]);
    const models = asRecord(provider.models);
    const model = asRecord(models[modelId]);
    merged = {
      ...merged,
      [providerId]: {
        ...provider,
        models: {
          ...models,
          [modelId]: {
            ...definition,
            ...model,
            modalities: {
              ...definition.modalities,
              ...asRecord(model.modalities),
            },
            limit: { ...definition.limit, ...asRecord(model.limit) },
          },
        },
      },
    };
  }

  return merged;
}
