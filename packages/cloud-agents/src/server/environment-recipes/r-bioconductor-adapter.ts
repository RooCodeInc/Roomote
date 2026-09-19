import {
  ENVIRONMENT_RECIPE_SCHEMA_VERSION,
  R_BIOCONDUCTOR_RECIPE_TYPE,
  type EnvironmentRecipe,
  hasResolvedEnvironmentRecipe,
} from '@roomote/types';

import {
  stableRecipeJsonSha256,
  type EnvironmentRecipeControlAdapter,
  type RecipeValidationFailure,
} from './common';

export const R_BIOCONDUCTOR_RECIPE_IMAGE =
  'bioconductor/bioconductor_docker@sha256:41ed449aa2181f330cdc8d0499a11a7435b04827ff926dc141584a34f65a12cb' as const;
export const R_BIOCONDUCTOR_RECIPE_R_VERSION = '4.5.2' as const;
export const R_BIOCONDUCTOR_RECIPE_BIOCONDUCTOR_VERSION = '3.21' as const;

const R_FALLBACK_DISPLAY_NAME = 'R + Bioconductor Environment';

function normalizeRPackages(request: { packages: string[] }): {
  packages: string[];
} {
  const byLowercase = new Map<string, string>();
  for (const rawName of request.packages) {
    const name = rawName.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (!byLowercase.has(key)) byLowercase.set(key, name);
  }
  return {
    packages: [...byLowercase.values()].sort((left, right) =>
      left.toLowerCase().localeCompare(right.toLowerCase()),
    ),
  };
}

function computeRRequestFingerprint(request: { packages: string[] }): string {
  const normalized = normalizeRPackages(request);
  return stableRecipeJsonSha256({
    type: R_BIOCONDUCTOR_RECIPE_TYPE,
    schema_version: ENVIRONMENT_RECIPE_SCHEMA_VERSION,
    request: normalized,
  });
}

function computeRResolutionFingerprint(
  resolution: NonNullable<EnvironmentRecipe['resolution']>,
): string {
  return stableRecipeJsonSha256(resolution);
}

function isCompatibleREnvironment(
  environment: {
    isVerified?: boolean;
    config: { environment_recipe?: EnvironmentRecipe };
  },
  request: { packages: string[] },
): boolean {
  const recipe = environment.config.environment_recipe;
  if (
    !environment.isVerified ||
    recipe?.type !== R_BIOCONDUCTOR_RECIPE_TYPE ||
    !hasResolvedEnvironmentRecipe(recipe) ||
    recipe.resolution.image !== R_BIOCONDUCTOR_RECIPE_IMAGE ||
    recipe.resolution.r_version !== R_BIOCONDUCTOR_RECIPE_R_VERSION ||
    recipe.resolution.bioconductor_version !==
      R_BIOCONDUCTOR_RECIPE_BIOCONDUCTOR_VERSION
  ) {
    return false;
  }

  const available = new Set(
    recipe.resolution.packages.map((pkg) => pkg.name.toLowerCase()),
  );
  return request.packages.every((name) =>
    available.has(name.trim().toLowerCase()),
  );
}

function validateResolvedRRecipe(
  recipe: EnvironmentRecipe,
): { valid: true } | RecipeValidationFailure {
  if (recipe.type !== R_BIOCONDUCTOR_RECIPE_TYPE) {
    return { valid: false, error: `Unsupported recipe type ${recipe.type}` };
  }
  if (!hasResolvedEnvironmentRecipe(recipe)) {
    return { valid: false, error: 'Recipe has no resolution' };
  }
  const resolution = recipe.resolution;
  if (resolution.image !== R_BIOCONDUCTOR_RECIPE_IMAGE) {
    return {
      valid: false,
      error: 'Resolution must use the pinned R/Bioconductor image',
    };
  }
  if (
    resolution.r_version !== R_BIOCONDUCTOR_RECIPE_R_VERSION ||
    resolution.bioconductor_version !==
      R_BIOCONDUCTOR_RECIPE_BIOCONDUCTOR_VERSION
  ) {
    return {
      valid: false,
      error: 'Resolution must match the pinned R and Bioconductor versions',
    };
  }
  const requested = new Set(
    recipe.request.packages.map((n) => n.toLowerCase()),
  );
  const resolvedNames = new Set<string>();
  for (const pkg of resolution.packages) {
    resolvedNames.add(pkg.name.toLowerCase());
    if (!pkg.version.trim()) {
      return {
        valid: false,
        error: `Resolved package ${pkg.name} has no version`,
      };
    }
  }
  for (const name of requested) {
    if (!resolvedNames.has(name)) {
      return {
        valid: false,
        error: `Requested package ${name} is missing from the resolution`,
      };
    }
  }
  const lock = resolution.renv_lock as Record<string, unknown> | undefined;
  const lockR = lock?.R as { Version?: unknown } | undefined;
  const lockBioconductor = lock?.Bioconductor as
    | { Version?: unknown }
    | undefined;
  if (
    lockR?.Version !== R_BIOCONDUCTOR_RECIPE_R_VERSION ||
    lockBioconductor?.Version !== R_BIOCONDUCTOR_RECIPE_BIOCONDUCTOR_VERSION ||
    !lock?.Packages ||
    typeof lock.Packages !== 'object'
  ) {
    return {
      valid: false,
      error: 'renv lock must match the pinned R and Bioconductor versions',
    };
  }
  return { valid: true };
}

function buildRVerificationInstructions(recipe: EnvironmentRecipe): string {
  const directPackages = recipe.request.packages;
  const loadable = directPackages.map(
    (name) => `library(${JSON.stringify(name)})`,
  );
  const checks = [
    `Verify the pinned R (${R_BIOCONDUCTOR_RECIPE_R_VERSION}) and Bioconductor (${R_BIOCONDUCTOR_RECIPE_BIOCONDUCTOR_VERSION}) versions.`,
    `Verify a clean restore of the persisted renv lock and load every directly requested package with ${loadable.join(', ')}.`,
  ];

  const requested = new Set(directPackages.map((name) => name.toLowerCase()));
  if (requested.has('deseq2') && requested.has('airway')) {
    checks.push(
      'Both DESeq2 and airway are requested, so also run a meaningful DESeq2 smoke analysis using the public airway data package: four samples, a bounded gene subset, construct a DESeqDataSet, run DESeq, and require non-empty results.',
    );
  } else {
    checks.push(
      'Run a minimal end-to-end exercise of the direct packages; do not force DESeq2 or airway unless the script requests them.',
    );
  }

  return checks.join(' ');
}

export const rBioconductorControlAdapter: EnvironmentRecipeControlAdapter = {
  type: R_BIOCONDUCTOR_RECIPE_TYPE,
  schemaVersion: ENVIRONMENT_RECIPE_SCHEMA_VERSION,
  fallbackDisplayName: R_FALLBACK_DISPLAY_NAME,
  normalizeRequest: normalizeRPackages,
  computeRequestFingerprint: computeRRequestFingerprint,
  computeResolutionFingerprint: computeRResolutionFingerprint,
  describeSetupRequest(request) {
    return {
      setupTimeBoundMinutes: 90,
      persistenceImpact:
        'Creates one durable, deployment-shared R/Bioconductor environment reused by every future compatible analysis.',
      impactSummary: `Resolves ${request.packages.length} R package(s) from the official CRAN/Bioconductor repositories inside the pinned image (${R_BIOCONDUCTOR_RECIPE_R_VERSION}/${R_BIOCONDUCTOR_RECIPE_BIOCONDUCTOR_VERSION}), snapshots a full renv lock, and verifies a strict clean restore.`,
    };
  },
  isCompatible: isCompatibleREnvironment,
  validateResolvedRecipe: validateResolvedRRecipe,
  buildVerificationInstructions: buildRVerificationInstructions,
};
