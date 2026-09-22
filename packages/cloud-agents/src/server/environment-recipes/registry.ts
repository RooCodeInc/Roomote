import type { EnvironmentRecipe } from '@roomote/types';

import type { EnvironmentRecipeControlAdapter } from './common';
import { rBioconductorControlAdapter } from './r-bioconductor-adapter';

const CONTROL_ADAPTERS: EnvironmentRecipeControlAdapter[] = [
  rBioconductorControlAdapter,
];

/**
 * Control-plane environment recipe registry. Adding a new environment type
 * means: extend the `environmentRecipeSchema` union in `@roomote/types` and
 * register one control adapter here plus one worker adapter in
 * `apps/worker/src/recipes`. Fast orchestration never special-cases recipe
 * types.
 */
export function getRecipeControlAdapter(
  type: EnvironmentRecipe['type'],
): EnvironmentRecipeControlAdapter | undefined {
  return CONTROL_ADAPTERS.find((adapter) => adapter.type === type);
}

export function requireRecipeControlAdapter(
  type: EnvironmentRecipe['type'],
): EnvironmentRecipeControlAdapter {
  const adapter = getRecipeControlAdapter(type);
  if (!adapter) {
    throw new Error(
      `No control-plane adapter registered for recipe type ${type}`,
    );
  }
  return adapter;
}

export function listRecipeControlAdapterTypes(): EnvironmentRecipe['type'][] {
  return CONTROL_ADAPTERS.map((adapter) => adapter.type);
}
