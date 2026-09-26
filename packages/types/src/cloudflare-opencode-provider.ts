import {
  getInferenceGatewayProvider,
  INFERENCE_GATEWAY_IDENTITY_PATTERN,
  INFERENCE_GATEWAY_RESOURCE_PATTERN,
  toCloudflareAiGatewayUpstreamModelId,
  type InferenceGatewayProvider,
} from './inference-gateway';
import { getSetupModelProvider } from './model-provider-config';

/**
 * Cloudflare OpenCode wiring shared by the task worker and the non-task
 * helper servers.
 *
 * OpenCode's models.dev catalog is not sufficient for either Cloudflare
 * inference provider: the `cloudflare-ai-gateway` catalog entry would resolve
 * to a package that ignores Roomote's `/v1/chat/completions` route shape, and
 * `cloudflare-workers-ai` is not covered for the credential names Roomote
 * stores. Both are therefore registered in full (npm package, base URL,
 * credential env var, header, and model entries) against Cloudflare's
 * OpenAI-compatible `/ai/v1` surface, using Roomote's namespaced env vars
 * instead of any shared `CLOUDFLARE_*` name the runtime catalog assumes.
 *
 * models.dev also stores hosted Workers AI models under a `workers-ai/`
 * namespace on the AI Gateway provider, while Cloudflare's `/ai/v1` expects
 * the `@cf/...` id with that namespace removed — so model ids are rewritten
 * here before they land in the config.
 */

const CLOUDFLARE_AI_GATEWAY_OPENCODE_PROVIDER_ID = 'cloudflare-ai-gateway';
const CLOUDFLARE_WORKERS_AI_OPENCODE_PROVIDER_ID = 'cloudflare-workers-ai';

const CLOUDFLARE_OPENCODE_PROVIDER_IDS = [
  CLOUDFLARE_AI_GATEWAY_OPENCODE_PROVIDER_ID,
  CLOUDFLARE_WORKERS_AI_OPENCODE_PROVIDER_ID,
] as const;

const CLOUDFLARE_OPENCODE_NPM_PACKAGE = '@ai-sdk/openai-compatible';

type RuntimeEnv = Readonly<Record<string, string | undefined>>;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

function readRequiredEnv(
  runtimeEnv: RuntimeEnv,
  envVarName: string | undefined,
): string | undefined {
  return envVarName ? runtimeEnv[envVarName]?.trim() || undefined : undefined;
}

/**
 * Emit openai-compat providers against Cloudflare `/ai/v1` using Roomote's
 * namespaced env vars, not models.dev's shared `CLOUDFLARE_ACCOUNT_ID`. Used
 * by control-plane helpers and by direct-mode task execution when the
 * inference gateway is absent.
 */
export function mergeCloudflareOpenCodeProviderConfig(
  providerConfig: Record<string, unknown>,
  runtimeEnv: RuntimeEnv,
  modelIds: Array<string | undefined>,
): Record<string, unknown> {
  let merged = providerConfig;

  for (const providerId of CLOUDFLARE_OPENCODE_PROVIDER_IDS) {
    const gatewayProvider = getInferenceGatewayProvider(providerId);
    const setupProvider = getSetupModelProvider(providerId);

    if (!gatewayProvider?.resource || !setupProvider.envVarName) {
      continue;
    }

    const prefix = `${providerId}/`;
    const modelIdsForProvider = [
      ...new Set(
        modelIds.flatMap((modelId) => {
          const normalized = modelId?.trim();
          return normalized?.startsWith(prefix)
            ? [
                providerId === CLOUDFLARE_AI_GATEWAY_OPENCODE_PROVIDER_ID
                  ? toCloudflareAiGatewayUpstreamModelId(
                      normalized.slice(prefix.length),
                    )
                  : normalized.slice(prefix.length),
              ]
            : [];
        }),
      ),
    ];

    if (modelIdsForProvider.length === 0) {
      continue;
    }

    const existingProvider = asRecord(merged[providerId]);
    const existingOptions = asRecord(existingProvider.options);
    const existingModels = asRecord(existingProvider.models);
    const options: Record<string, unknown> = {
      ...existingOptions,
    };
    const apiKey = readRequiredEnv(runtimeEnv, setupProvider.envVarName);
    const accountId = readRequiredEnv(
      runtimeEnv,
      gatewayProvider.resource.envVarName,
    );
    // Register rewritten models even when the token is withheld so gateway
    // mode can select `@cf/...` ids. Attach a direct `/ai/v1` URL only when
    // the namespaced credentials are present in this env.
    if (
      apiKey &&
      accountId &&
      INFERENCE_GATEWAY_RESOURCE_PATTERN.test(accountId)
    ) {
      options.baseURL = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`;
      options.apiKey = `{env:${setupProvider.envVarName}}`;

      if (
        !appendRequiredCloudflareHeaders(options, gatewayProvider, runtimeEnv)
      ) {
        delete options.baseURL;
        delete options.apiKey;
        delete options.headers;
      }
    }

    merged = {
      ...merged,
      [providerId]: {
        ...existingProvider,
        npm: CLOUDFLARE_OPENCODE_NPM_PACKAGE,
        name: setupProvider.label,
        options,
        models: {
          ...existingModels,
          ...Object.fromEntries(
            modelIdsForProvider.map((modelId) => [
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

  return merged;
}

function appendRequiredCloudflareHeaders(
  options: Record<string, unknown>,
  gatewayProvider: InferenceGatewayProvider,
  runtimeEnv: RuntimeEnv,
): boolean {
  if (!gatewayProvider.requiredHeaders?.length) {
    return true;
  }

  const headers = {
    ...asRecord(options.headers),
  };

  for (const spec of gatewayProvider.requiredHeaders) {
    const value = readRequiredEnv(runtimeEnv, spec.envVarName);

    if (!value || !INFERENCE_GATEWAY_IDENTITY_PATTERN.test(value)) {
      return false;
    }

    headers[spec.headerName] = value;
  }

  options.headers = headers;
  return true;
}
