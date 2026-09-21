import type { EnvironmentRecipe } from '@roomote/types';

import type { EnvironmentRecipeWorkerAdapter } from './common';
import { rBioconductorWorkerAdapter } from './r-bioconductor';

const WORKER_ADAPTERS: EnvironmentRecipeWorkerAdapter[] = [
  rBioconductorWorkerAdapter,
];

export function getRecipeWorkerAdapter(
  type: EnvironmentRecipe['type'],
): EnvironmentRecipeWorkerAdapter | undefined {
  return WORKER_ADAPTERS.find((adapter) => adapter.type === type);
}
