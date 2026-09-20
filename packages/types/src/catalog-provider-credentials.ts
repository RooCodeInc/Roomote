import { getInferenceGatewayProvider } from './inference-gateway';

/**
 * OpenCode wiring for built-in providers whose credential OpenCode would not
 * find on its own, shared by the task worker and the non-task helper servers.
 *
 * OpenCode takes a provider's API key from the env var its model catalog
 * names, but only when the catalog lists exactly one; otherwise the key is
 * left to the provider SDK's own default env var. Either way the name can
 * differ from the one Roomote stores the key under:
 * - Z.AI and the Z.AI Coding Plan share `ZHIPU_API_KEY` in the catalog, and
 *   OpenCode Go shares `OPENCODE_API_KEY` with Zen, while Roomote keeps each
 *   as a separate credential.
 * - Azure AI Foundry uses the Azure SDK, which reads `AZURE_API_KEY`, the
 *   Azure OpenAI provider's key.
 * - Google's SDK reads `GOOGLE_GENERATIVE_AI_API_KEY`, while Roomote's setup
 *   stores the key as `GEMINI_API_KEY`.
 * Left alone, OpenCode sends these requests with no key, or with another
 * provider's.
 *
 * The inference gateway already covers task runs by replacing the key and
 * base URL. This binds the key for everything that calls the provider
 * directly: the non-task helpers, and task runs without a gateway.
 */
const CATALOG_CREDENTIAL_PROVIDER_IDS = [
  'zai',
  'zai-coding-plan',
  'opencode-go',
  'azure-cognitive-services',
  'google',
] as const;

type RuntimeEnv = Readonly<Record<string, string | undefined>>;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

/**
 * The base URL for the deployment's configured region, when the provider has
 * regional endpoints and the region is not the one the catalog already uses.
 */
function resolveRegionalBaseUrl(
  providerId: string,
  runtimeEnv: RuntimeEnv,
): string | undefined {
  const region = getInferenceGatewayProvider(providerId)?.region;
  const baseUrls = region?.baseUrls;
  if (!region || !baseUrls) return undefined;

  const configured = runtimeEnv[region.envVarName]?.trim().toLowerCase();
  const selected = configured && configured in baseUrls ? configured : null;
  // The catalog entry is the default region's endpoint already.
  return selected && selected !== region.default
    ? baseUrls[selected]
    : undefined;
}

/**
 * The env var to bind this provider's key to, if any.
 *
 * A provider with a single name is always bound to it. One that accepts
 * several (the SDK's native name before Roomote's alias, in precedence order)
 * is bound to the first that is actually set, and left alone when none is
 * visible: binding to an unset name would hand OpenCode an empty key and
 * break a deployment the SDK's own default lookup would have served.
 */
function resolveApiKeyEnvVarName(
  providerId: string,
  runtimeEnv: RuntimeEnv,
): string | undefined {
  const envVarNames =
    getInferenceGatewayProvider(providerId)?.envVarNames ?? [];
  return envVarNames.length === 1
    ? envVarNames[0]
    : envVarNames.find((name) => runtimeEnv[name]?.trim());
}

/**
 * Binds each selected provider's API key to the env var Roomote stores it
 * under, and points it at the configured region's endpoint. Existing options
 * win, and in gateway mode the rebase applied afterwards replaces both.
 */
export function mergeCatalogProviderCredentialConfig(
  providerConfig: Record<string, unknown>,
  runtimeEnv: RuntimeEnv,
  modelIds: Array<string | undefined>,
): Record<string, unknown> {
  let merged = providerConfig;

  for (const providerId of CATALOG_CREDENTIAL_PROVIDER_IDS) {
    const prefix = `${providerId}/`;
    if (!modelIds.some((modelId) => modelId?.trim().startsWith(prefix))) {
      continue;
    }

    const apiKeyEnvVarName = resolveApiKeyEnvVarName(providerId, runtimeEnv);
    if (!apiKeyEnvVarName) continue;

    const existingProvider = asRecord(merged[providerId]);
    const baseURL = resolveRegionalBaseUrl(providerId, runtimeEnv);

    merged = {
      ...merged,
      [providerId]: {
        ...existingProvider,
        options: {
          apiKey: `{env:${apiKeyEnvVarName}}`,
          ...(baseURL ? { baseURL } : {}),
          ...asRecord(existingProvider.options),
        },
      },
    };
  }

  return merged;
}
