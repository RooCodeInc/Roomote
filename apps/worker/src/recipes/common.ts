import { createHash } from 'node:crypto';

import type { Command, EnvironmentRecipe } from '@roomote/types';

/**
 * Worker-side environment recipe registry. Adding a new environment type
 * means: extend the `environmentRecipeSchema` union in `@roomote/types` and
 * register one worker adapter here plus one control adapter in
 * `packages/cloud-agents` — no Fast orchestration changes.
 */
export interface EnvironmentRecipeWorkerAdapter {
  type: EnvironmentRecipe['type'];
  /** Short visible name used for setup-status command grouping. */
  setupPlanName: string;
  /**
   * Resolution commands: resolve an unresolved request from official
   * repositories into a pinned, reproducible result. Commands may read from
   * and write into `recipePath`.
   */
  buildResolutionCommands(input: {
    recipe: EnvironmentRecipe;
    recipePath: string;
  }): readonly Command[];
  /**
   * Restore commands: install an already-resolved recipe without rerunning
   * dependency resolution.
   */
  buildRestoreCommands(input: {
    recipe: EnvironmentRecipe;
    recipePath: string;
  }): readonly Command[];
  /**
   * Read the resolution artifacts produced by the resolution commands and
   * return the resolved recipe, or null when resolution produced nothing
   * usable (the failing command already surfaced the error).
   */
  readResolvedRecipe(input: {
    recipe: EnvironmentRecipe;
    recipePath: string;
  }): Promise<EnvironmentRecipe | null>;
  /**
   * Optional workspace artifacts to write after a resolved recipe has been
   * restored (for example a read-only runtime runner).
   */
  afterRestore?(input: {
    recipe: EnvironmentRecipe;
    recipePath: string;
    workspacePath: string;
  }): Promise<void>;
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

function stableRecipeJsonSha256(value: unknown): string {
  return createHash('sha256').update(stableJsonStringify(value)).digest('hex');
}

export function computeResolutionFingerprint(
  resolution: Omit<
    NonNullable<EnvironmentRecipe['resolution']>,
    'resolution_fingerprint'
  >,
): string {
  return stableRecipeJsonSha256(resolution);
}
