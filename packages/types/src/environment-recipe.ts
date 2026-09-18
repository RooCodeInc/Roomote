import { z } from 'zod';

/**
 * Environment recipes: generic, on-demand runtime definitions a Roomote task
 * can request without a repository Dockerfile or lockfile. A recipe has a
 * normalized request, a request fingerprint, and — once a trusted worker has
 * resolved it — a complete pinned resolution with its own fingerprint.
 *
 * Unresolved recipes are an internal provisioning state; public environment
 * create/update surfaces must reject them (see
 * `getUnresolvedEnvironmentRecipeError`).
 */

export const R_BIOCONDUCTOR_RECIPE_TYPE = 'r-bioconductor' as const;
export const ENVIRONMENT_RECIPE_SCHEMA_VERSION = 1 as const;

const recipeFingerprintSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, 'fingerprint must be a SHA-256 hex digest');

const rPackageNameSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z][A-Za-z0-9.]*$/, 'Invalid R package name');

const rResolvedPackageSchema = z.object({
  name: rPackageNameSchema,
  version: z.string().min(1),
  repository: z.enum(['cran', 'bioconductor']),
});

const rBioconductorRecipeSchema = z
  .object({
    type: z.literal(R_BIOCONDUCTOR_RECIPE_TYPE),
    schema_version: z.literal(ENVIRONMENT_RECIPE_SCHEMA_VERSION),
    request: z.object({
      packages: z.array(rPackageNameSchema).min(1).max(100),
    }),
    request_fingerprint: recipeFingerprintSchema,
    resolution: z
      .object({
        image: z.string().min(1),
        r_version: z.string().min(1),
        bioconductor_version: z.string().min(1),
        packages: z.array(rResolvedPackageSchema).min(1),
        renv_lock: z.record(z.unknown()),
        resolution_fingerprint: recipeFingerprintSchema,
      })
      .optional(),
  })
  .superRefine((recipe, ctx) => {
    const seen = new Set<string>();
    for (const [index, name] of recipe.request.packages.entries()) {
      const key = name.toLowerCase();
      if (seen.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['request', 'packages', index],
          message: `Duplicate R package: ${name}`,
        });
      }
      seen.add(key);
    }
  });

export const environmentRecipeSchema = rBioconductorRecipeSchema;

export type RBioconductorRecipe = z.infer<typeof rBioconductorRecipeSchema>;
export type EnvironmentRecipe = z.infer<typeof environmentRecipeSchema>;
export type EnvironmentResolvedRecipe = EnvironmentRecipe & {
  resolution: NonNullable<EnvironmentRecipe['resolution']>;
};

/**
 * Identify recipe environments regardless of resolution state. Both the
 * control plane and the worker route through a recipe registry instead of
 * special-casing recipe types.
 */
export function getEnvironmentRecipe(
  config: { environment_recipe?: EnvironmentRecipe } | undefined,
): EnvironmentRecipe | undefined {
  return config?.environment_recipe;
}

export function hasResolvedEnvironmentRecipe(
  recipe: EnvironmentRecipe | undefined,
): recipe is EnvironmentResolvedRecipe {
  return Boolean(recipe?.resolution);
}

export const UNRESOLVED_ENVIRONMENT_RECIPE_PUBLIC_ERROR =
  'environment_recipe with no resolution is an internal provisioning state and cannot be saved directly.';

/**
 * Public environment create/update surfaces (API, web tRPC, the
 * `manage_environments` MCP tool) must reject an unresolved recipe. Only the
 * trusted Fast provisioning path may persist one.
 */
export function getUnresolvedEnvironmentRecipeError(config: {
  environment_recipe?: EnvironmentRecipe;
}): string | null {
  if (
    getEnvironmentRecipe(config) &&
    !hasResolvedEnvironmentRecipe(getEnvironmentRecipe(config))
  ) {
    return UNRESOLVED_ENVIRONMENT_RECIPE_PUBLIC_ERROR;
  }
  return null;
}
