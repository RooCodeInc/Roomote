import { type EnvironmentConfig } from '@roomote/types';
import type { RoutableEnvironment } from '../available-environments';
import {
  getRecipeControlAdapter,
  type EnvironmentRecipeControlAdapter,
} from '../environment-recipes';

export function isConfiguredEnvironmentId(
  environmentId: string | null | undefined,
  environments: RoutableEnvironment[],
): environmentId is string {
  return Boolean(
    environmentId &&
    environments.some((environment) => environment.id === environmentId),
  );
}

/**
 * Recipe compatibility through the control registry. Matching ignores the
 * display name and requires a verified, resolved recipe whose direct package
 * set is a superset of the request.
 */
export function isCompatibleRecipeEnvironment(
  environment: {
    isVerified?: boolean;
    config?: EnvironmentConfig;
  },
  request: { packages: string[] },
  adapter?: EnvironmentRecipeControlAdapter,
): boolean {
  const recipe = environment.config?.environment_recipe;
  if (!recipe) {
    return false;
  }
  const resolvedAdapter = adapter ?? getRecipeControlAdapter(recipe.type);
  if (!resolvedAdapter) {
    return false;
  }
  return resolvedAdapter.isCompatible(
    {
      isVerified: environment.isVerified,
      config: { environment_recipe: recipe },
    },
    request,
  );
}

/**
 * An unresolved or unverified recipe environment is never routable for
 * normal work; environment_verification launches remain allowed.
 */
export function isRecipeEnvironmentBlockedFromLaunch(
  environment: RoutableEnvironment,
): boolean {
  const recipe = environment.config?.environment_recipe;
  if (!recipe) {
    return false;
  }
  return !recipe.resolution || !environment.isVerified;
}
