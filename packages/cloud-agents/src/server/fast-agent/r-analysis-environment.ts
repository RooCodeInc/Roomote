import {
  R_BIOCONDUCTOR_RECIPE_CATALOG_ID,
  type EnvironmentConfig,
} from '@roomote/types';

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
