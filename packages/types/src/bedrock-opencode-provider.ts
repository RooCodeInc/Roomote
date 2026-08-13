import {
  AMAZON_BEDROCK_OPENCODE_PROVIDER_ID,
  BEDROCK_MANTLE_OPENAI_OPENCODE_PROVIDER_ID,
  BEDROCK_MANTLE_OPENCODE_PROVIDER_ID,
  DEFAULT_BEDROCK_MANTLE_REGION,
  INFERENCE_GATEWAY_REGION_PATTERN,
} from './inference-gateway';

/**
 * Amazon Bedrock OpenCode wiring shared by the task worker and the non-task
 * helper servers. OpenCode's catalog knows the native `amazon-bedrock`
 * provider but none of the Bedrock Mantle endpoints, and none of the three
 * read the deployment's bearer-token credential on their own — so a Bedrock
 * model id from deployment settings only resolves once these helpers have
 * rewritten it and registered its provider in the OpenCode config. The worker
 * has always done this for task execution; helper servers must apply the same
 * alignment or Bedrock-configured helper models fail with
 * ProviderModelNotFoundError before any request is made.
 */

type RuntimeEnv = Readonly<Record<string, string | undefined>>;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

function resolveBedrockRegion(runtimeEnv: RuntimeEnv): string {
  const region = runtimeEnv.AWS_REGION?.trim() || DEFAULT_BEDROCK_MANTLE_REGION;

  if (!INFERENCE_GATEWAY_REGION_PATTERN.test(region)) {
    throw new Error(
      `AWS_REGION must be a valid AWS region for Amazon Bedrock. Received "${region}".`,
    );
  }

  return region;
}

function collectModelIdsForPrefix(
  modelIds: Array<string | undefined>,
  providerId: string,
): string[] {
  const prefix = `${providerId}/`;

  return [
    ...new Set(
      modelIds.flatMap((modelId) => {
        const normalized = modelId?.trim();

        return normalized?.startsWith(prefix)
          ? [normalized.slice(prefix.length)]
          : [];
      }),
    ),
  ];
}

/**
 * Bedrock Mantle serves GPT models through its OpenAI-compatible endpoint
 * (Responses API), not the Anthropic Messages endpoint the `bedrock-mantle`
 * provider targets. Rewrite `bedrock-mantle/openai.*` — and the equivalent
 * native spelling `amazon-bedrock/openai.*` — onto the dedicated
 * `bedrock-mantle-openai` provider that
 * {@link mergeBedrockMantleOpenAiProviderConfig} registers.
 */
export function toBedrockMantleRuntimeModelId(modelId: string): string {
  const mantlePrefix = `${BEDROCK_MANTLE_OPENCODE_PROVIDER_ID}/openai.`;
  const nativePrefix = `${AMAZON_BEDROCK_OPENCODE_PROVIDER_ID}/openai.`;

  if (modelId.startsWith(mantlePrefix)) {
    return `${BEDROCK_MANTLE_OPENAI_OPENCODE_PROVIDER_ID}/${modelId.slice(
      BEDROCK_MANTLE_OPENCODE_PROVIDER_ID.length + 1,
    )}`;
  }

  if (modelId.startsWith(nativePrefix)) {
    return `${BEDROCK_MANTLE_OPENAI_OPENCODE_PROVIDER_ID}/${modelId.slice(
      AMAZON_BEDROCK_OPENCODE_PROVIDER_ID.length + 1,
    )}`;
  }

  return modelId;
}

/**
 * Registers the `bedrock-mantle` provider (Anthropic Messages endpoint) for
 * any selected `bedrock-mantle/...` model, wiring the region-scoped base URL
 * and the deployment's bearer token.
 */
export function mergeBedrockMantleProviderConfig(
  providerConfig: Record<string, unknown>,
  runtimeEnv: RuntimeEnv,
  modelIds: Array<string | undefined>,
): Record<string, unknown> {
  const mantleModelIds = collectModelIdsForPrefix(
    modelIds,
    BEDROCK_MANTLE_OPENCODE_PROVIDER_ID,
  );

  if (mantleModelIds.length === 0) {
    return providerConfig;
  }

  const region = resolveBedrockRegion(runtimeEnv);
  const existingProvider = asRecord(
    providerConfig[BEDROCK_MANTLE_OPENCODE_PROVIDER_ID],
  );
  const existingOptions = asRecord(existingProvider.options);
  const existingModels = asRecord(existingProvider.models);
  const models = Object.fromEntries(
    mantleModelIds.map((modelId) => [
      modelId,
      {
        name: modelId,
        ...asRecord(existingModels[modelId]),
      },
    ]),
  );

  return {
    ...providerConfig,
    [BEDROCK_MANTLE_OPENCODE_PROVIDER_ID]: {
      ...existingProvider,
      npm: '@ai-sdk/anthropic',
      name: 'Amazon Bedrock',
      options: {
        ...existingOptions,
        baseURL: `https://bedrock-mantle.${region}.api.aws/anthropic/v1`,
        apiKey: '{env:AWS_BEARER_TOKEN_BEDROCK}',
      },
      models: {
        ...existingModels,
        ...models,
      },
    },
  };
}

/**
 * Registers the `bedrock-mantle-openai` provider for any selected
 * `bedrock-mantle-openai/...` model (the rewrite target of
 * {@link toBedrockMantleRuntimeModelId}).
 */
export function mergeBedrockMantleOpenAiProviderConfig(
  providerConfig: Record<string, unknown>,
  runtimeEnv: RuntimeEnv,
  modelIds: Array<string | undefined>,
): Record<string, unknown> {
  const mantleModelIds = collectModelIdsForPrefix(
    modelIds,
    BEDROCK_MANTLE_OPENAI_OPENCODE_PROVIDER_ID,
  );

  if (mantleModelIds.length === 0) {
    return providerConfig;
  }

  const region = resolveBedrockRegion(runtimeEnv);
  const existingProvider = asRecord(
    providerConfig[BEDROCK_MANTLE_OPENAI_OPENCODE_PROVIDER_ID],
  );
  const existingOptions = asRecord(existingProvider.options);
  const existingModels = asRecord(existingProvider.models);

  return {
    ...providerConfig,
    [BEDROCK_MANTLE_OPENAI_OPENCODE_PROVIDER_ID]: {
      ...existingProvider,
      // Mantle GPT models support the OpenAI Responses API, not Chat
      // Completions. The native provider selects the Responses transport.
      npm: '@ai-sdk/openai',
      name: 'Amazon Bedrock',
      options: {
        ...existingOptions,
        baseURL: `https://bedrock-mantle.${region}.api.aws/openai/v1`,
        apiKey: '{env:AWS_BEARER_TOKEN_BEDROCK}',
      },
      models: {
        ...existingModels,
        ...Object.fromEntries(
          mantleModelIds.map((modelId) => [
            modelId,
            {
              name: modelId,
              ...asRecord(existingModels[modelId]),
            },
          ]),
        ),
      },
    },
  };
}

/**
 * Registers bearer-token credentials and model entries on OpenCode's native
 * `amazon-bedrock` provider for any selected `amazon-bedrock/...` model. The
 * catalog knows the provider, but not the deployment's credential.
 */
export function mergeAmazonBedrockProviderConfig(
  providerConfig: Record<string, unknown>,
  runtimeEnv: RuntimeEnv,
  modelIds: Array<string | undefined>,
): Record<string, unknown> {
  const bedrockModelIds = collectModelIdsForPrefix(
    modelIds,
    AMAZON_BEDROCK_OPENCODE_PROVIDER_ID,
  );

  if (bedrockModelIds.length === 0) {
    return providerConfig;
  }

  resolveBedrockRegion(runtimeEnv);

  const existingProvider = asRecord(
    providerConfig[AMAZON_BEDROCK_OPENCODE_PROVIDER_ID],
  );
  const existingOptions = asRecord(existingProvider.options);
  const existingModels = asRecord(existingProvider.models);

  return {
    ...providerConfig,
    [AMAZON_BEDROCK_OPENCODE_PROVIDER_ID]: {
      ...existingProvider,
      npm: '@ai-sdk/amazon-bedrock',
      name: 'Amazon Bedrock',
      options: {
        apiKey: '{env:AWS_BEARER_TOKEN_BEDROCK}',
        ...existingOptions,
      },
      models: {
        ...existingModels,
        ...Object.fromEntries(
          bedrockModelIds.map((modelId) => [
            modelId,
            {
              name: modelId,
              ...asRecord(existingModels[modelId]),
            },
          ]),
        ),
      },
    },
  };
}
