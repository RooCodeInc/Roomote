import { getInferenceGatewayProvider } from './inference-gateway';

/**
 * OpenCode wiring for built-in providers whose credential OpenCode would not
 * find on its own, shared by the task worker and the non-task helper servers.
 *
 * OpenCode reads a provider's API key from the env var its model catalog
 * names. Roomote stores these providers' keys under its own names because the
 * catalog's name is not specific enough: Z.AI and the Z.AI Coding Plan share
 * `ZHIPU_API_KEY` there, and OpenCode Go shares `OPENCODE_API_KEY` with Zen,
 * while Roomote keeps each as a separate credential. Left to the catalog,
 * OpenCode sends these requests with no key at all.
 *
 * The inference gateway already covers task runs by replacing the key and
 * base URL. This binds the key for everything that calls the provider
 * directly: the non-task helpers, and task runs without a gateway.
 */
const CATALOG_CREDENTIAL_PROVIDER_IDS = [
  'zai',
  'zai-coding-plan',
  'opencode-go',
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

    const apiKeyEnvVarName =
      getInferenceGatewayProvider(providerId)?.envVarNames[0];
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
