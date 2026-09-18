import { createHash } from 'node:crypto';

import type { EnvironmentConfig, EnvironmentRecipe } from '@roomote/types';

export interface EnvironmentRecipeRequestDescriptor {
  setupTimeBoundMinutes: number;
  persistenceImpact: string;
  impactSummary: string;
}

export interface RecipeValidationFailure {
  valid: false;
  error: string;
}

export interface EnvironmentRecipeControlAdapter {
  type: EnvironmentRecipe['type'];
  schemaVersion: EnvironmentRecipe['schema_version'];
  /** Normalize (trim, dedupe, sort) an incoming packages request. */
  normalizeRequest(request: { packages: string[] }): { packages: string[] };
  computeRequestFingerprint(request: { packages: string[] }): string;
  computeResolutionFingerprint(
    resolution: NonNullable<EnvironmentRecipe['resolution']>,
  ): string;
  /**
   * Runtime/impact disclosure bound into the proposal fingerprint so a stale
   * preview cannot silently authorize materially different work.
   */
  describeSetupRequest(request: {
    packages: string[];
  }): EnvironmentRecipeRequestDescriptor;
  /** Verified runtime/package-set compatibility (display name irrelevant). */
  isCompatible(
    environment: {
      isVerified?: boolean;
      config: Pick<EnvironmentConfig, 'environment_recipe'>;
    },
    request: { packages: string[] },
  ): boolean;
  /** Pinned-runtime and metadata acceptance for a resolved recipe. */
  validateResolvedRecipe(
    recipe: EnvironmentRecipe,
  ): { valid: true } | RecipeValidationFailure;
  /** Verification instructions embedded into the verification task prompt. */
  buildVerificationInstructions(recipe: EnvironmentRecipe): string;
  /** Fallback human-readable environment name. */
  fallbackDisplayName: string;
}

function stableJsonStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJsonStringify).join(',')}]`;
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([key, entryValue]) =>
          `${JSON.stringify(key)}:${stableJsonStringify(entryValue)}`,
      );
    return `{${entries.join(',')}}`;
  }

  return JSON.stringify(value);
}

export function stableRecipeJsonSha256(value: unknown): string {
  return createHash('sha256').update(stableJsonStringify(value)).digest('hex');
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
