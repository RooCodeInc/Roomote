import { splitTaskModelId } from './opencode-reasoning';

/**
 * OpenRouter variant suffixes (`:nitro`, `:free`, `:floor`, ...) are not
 * catalog model IDs, so OpenCode's model lookup rejects them with
 * `ProviderModelNotFoundError`. The helpers here rewrite a suffixed OpenRouter
 * model onto its catalog base model plus a per-model config entry:
 *
 * - Routing variants (`:nitro`, `:floor`) are exactly equivalent to
 *   OpenRouter's `provider.sort` request option, so the entry sets per-model
 *   `options` on the untouched catalog model. All catalog metadata (cost,
 *   limits, tool support) is preserved, keeping OpenCode's cost reporting and
 *   context management working.
 * - Endpoint variants (`:free`, `:extended`, ...) are selectable only by wire
 *   ID, so the entry overrides `id` with the suffixed model. OpenCode looks up
 *   catalog metadata by that `id` and misses, so cost and limit metadata fall
 *   back to zero — an upstream OpenCode limitation.
 *
 * The rewrite redefines what the base model ID means for the entire generated
 * config, so a role configured with the plain base model shares the variant
 * routing of a role that configured a variant of it, and when roles disagree
 * on the variant of a shared base model the highest-precedence role wins.
 */

const OPENROUTER_PROVIDER_ID = 'openrouter';

const OPENROUTER_VARIANT_MODEL_ID_PATTERN =
  /^(?<base>[^:]+):(?<variant>[a-z0-9-]+)$/i;

/**
 * Variants that are documented shortcuts for `provider` routing options
 * (https://openrouter.ai/docs/features/provider-routing) and therefore do not
 * need a wire-ID override.
 */
const OPENROUTER_VARIANT_ROUTING_OPTIONS: Record<
  string,
  Record<string, unknown>
> = {
  nitro: { provider: { sort: 'throughput' } },
  floor: { provider: { sort: 'price' } },
};

export interface OpenRouterVariantModelAlias {
  /** Qualified catalog model without the variant suffix, e.g. `openrouter/z-ai/glm-5.2`. */
  baseModel: string;
  /** Provider-relative catalog model ID used as the config entry key, e.g. `z-ai/glm-5.2`. */
  baseModelID: string;
  /** Provider-relative model ID including the variant suffix, e.g. `z-ai/glm-5.2:nitro`. */
  variantModelID: string;
  /**
   * Request options exactly equivalent to the variant, when it is a routing
   * shortcut. Set for `:nitro`/`:floor`; unset for endpoint variants, which
   * fall back to the `id` override.
   */
  routingOptions?: Record<string, unknown>;
}

export function resolveOpenRouterVariantModelAlias(
  modelId: string,
): OpenRouterVariantModelAlias | null {
  const selection = splitTaskModelId(modelId);

  if (!selection || selection.providerID !== OPENROUTER_PROVIDER_ID) {
    return null;
  }

  const groups = OPENROUTER_VARIANT_MODEL_ID_PATTERN.exec(
    selection.modelID,
  )?.groups;

  if (!groups?.base || !groups.variant) {
    return null;
  }

  const routingOptions =
    OPENROUTER_VARIANT_ROUTING_OPTIONS[groups.variant.toLowerCase()];

  return {
    baseModel: `${OPENROUTER_PROVIDER_ID}/${groups.base}`,
    baseModelID: groups.base,
    variantModelID: selection.modelID,
    ...(routingOptions ? { routingOptions } : {}),
  };
}

/**
 * Rewrites an OpenRouter variant model to its qualified catalog base model and
 * records the alias for the generated `provider` config. Non-variant models
 * pass through untouched. Distinct variants of a shared base model collide on
 * the same alias key, so the first collected alias wins — callers collect
 * roles in precedence order (per-task override first, then the coding model,
 * then helper roles).
 */
export function collectOpenRouterVariantModelAlias(
  aliases: Map<string, OpenRouterVariantModelAlias>,
  modelId: string,
): string {
  const alias = resolveOpenRouterVariantModelAlias(modelId);

  if (!alias) {
    return modelId;
  }

  if (!aliases.has(alias.baseModelID)) {
    aliases.set(alias.baseModelID, alias);
  }

  return alias.baseModel;
}

/**
 * Merges collected variant aliases into an OpenCode `provider` config subtree
 * under `provider.openrouter.models.<base>`, preserving existing per-model
 * entries such as reasoning `options`. Routing variants merge their request
 * options into the entry's `options`; endpoint variants set the entry's `id`.
 */
export function mergeOpenRouterVariantAliasModels(
  providerConfig: Record<string, unknown>,
  aliases: Map<string, OpenRouterVariantModelAlias>,
): Record<string, unknown> {
  if (aliases.size === 0) {
    return providerConfig;
  }

  const providerEntry = asRecord(providerConfig[OPENROUTER_PROVIDER_ID]);
  const models = asRecord(providerEntry.models);

  for (const alias of aliases.values()) {
    const existing = asRecord(models[alias.baseModelID]);

    models[alias.baseModelID] = alias.routingOptions
      ? {
          ...existing,
          options: { ...asRecord(existing.options), ...alias.routingOptions },
        }
      : { ...existing, id: alias.variantModelID };
  }

  return {
    ...providerConfig,
    [OPENROUTER_PROVIDER_ID]: {
      ...providerEntry,
      models,
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}
