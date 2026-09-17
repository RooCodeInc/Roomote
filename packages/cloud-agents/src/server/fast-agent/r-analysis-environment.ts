import {
  R_BIOCONDUCTOR_RECIPE_CATALOG_ID,
  type EnvironmentConfig,
} from '@roomote/types';
import type { RoutableEnvironment } from '../available-environments';

export function isConfiguredEnvironmentId(
  environmentId: string | null | undefined,
  environments: RoutableEnvironment[],
): environmentId is string {
  return Boolean(
    environmentId &&
    environments.some((environment) => environment.id === environmentId),
  );
}

export function isCompatibleRAnalysisEnvironment(
  environment: { isVerified: boolean; config: EnvironmentConfig },
  packages: string[],
): boolean {
  const recipe = environment.config.analysis_recipe;
  if (
    !environment.isVerified ||
    recipe?.type !== 'r-bioconductor' ||
    recipe.catalog_id !== R_BIOCONDUCTOR_RECIPE_CATALOG_ID
  ) {
    return false;
  }

  const available = new Set(
    recipe.direct_packages.map((pkg) => pkg.name.toLowerCase()),
  );
  return packages.every((name) => available.has(name.toLowerCase()));
}
