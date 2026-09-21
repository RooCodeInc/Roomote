import { and, desc, eq, inArray, sql } from 'drizzle-orm';

import {
  activeRunStatuses,
  type EnvironmentConfig,
  type EnvironmentRecipe,
} from '@roomote/types';

import { db, type DatabaseOrTransaction } from '../db';
import { environments, taskRuns } from '../schema';
import { createEnvironmentConfigVersionSnapshot } from './environment-config-versions';
import { runInTransactionIfAvailable } from './transaction-utils';

function stableRecipeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableRecipeValue);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entryValue]) => [key, stableRecipeValue(entryValue)]),
    );
  }
  return value;
}

function resolutionsMatch(left: unknown, right: unknown): boolean {
  return (
    JSON.stringify(stableRecipeValue(left)) ===
    JSON.stringify(stableRecipeValue(right))
  );
}

/**
 * Environment recipes: on-demand environments created through the trusted
 * Fast provisioning path with an unresolved recipe, then resolved by a
 * worker-owned nested-Docker resolution and finalized through a dedicated
 * endpoint instead of the ordinary environment-update helper. Keeping these
 * helpers package-owned prevents API, Fast, and worker paths from drifting.
 */

export const ENVIRONMENT_RECIPE_NAME_UNAVAILABLE = 'name_unavailable';

export class EnvironmentRecipeNameUnavailableError extends Error {
  constructor(name: string) {
    super(
      `Environment name "${name}" is already used by an incompatible environment. Choose another meaningful qualifier.`,
    );
    this.name = 'EnvironmentRecipeNameUnavailableError';
  }
}

export type EnsureEnvironmentRecipeCandidateInput = {
  config: EnvironmentConfig;
  createdByUserId: string;
};

export type EnsureEnvironmentRecipeCandidateResult = {
  environmentId: string;
  name: string;
  created: boolean;
};

export async function getActiveRecipeVerificationTaskId(
  dbOrTx: DatabaseOrTransaction,
  environmentId: string,
): Promise<string | null> {
  const [active] = await dbOrTx
    .select({ taskId: taskRuns.taskId })
    .from(taskRuns)
    .where(
      and(
        inArray(taskRuns.status, [...activeRunStatuses]),
        sql`${taskRuns.payload} ->> 'verifiesEnvironmentId' = ${environmentId}`,
      ),
    )
    .orderBy(desc(taskRuns.createdAt), desc(taskRuns.id))
    .limit(1);

  return active?.taskId ?? null;
}

/**
 * Create-or-reuse the environment-recipe candidate for a normalized request.
 *
 * An advisory transaction lock keyed by the recipe request fingerprint
 * prevents concurrent sessions from creating duplicate candidates; an
 * identical call reuses the first candidate (also the failed-enqueue retry).
 * A name owned by a different request fingerprint is reported as
 * `name_unavailable` rather than silently suffixed.
 */
export async function ensureEnvironmentRecipeCandidate(
  input: EnsureEnvironmentRecipeCandidateInput,
): Promise<EnsureEnvironmentRecipeCandidateResult> {
  const requestFingerprint =
    input.config.environment_recipe?.request_fingerprint;

  if (!requestFingerprint) {
    throw new Error(
      'Environment recipe candidates require a request fingerprint.',
    );
  }

  return runInTransactionIfAvailable(db, async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`environment-recipe:${requestFingerprint}`}))`,
    );

    const candidates = await tx
      .select({
        id: environments.id,
        name: environments.name,
      })
      .from(environments)
      .where(
        sql`${environments.config} -> 'environment_recipe' ->> 'request_fingerprint' = ${requestFingerprint}`,
      );

    const existing = candidates[0];
    if (existing) {
      return {
        environmentId: existing.id,
        name: existing.name,
        created: false,
      };
    }

    const nameTaken = await tx.query.environments.findFirst({
      where: eq(environments.name, input.config.name),
      columns: { id: true },
    });

    if (nameTaken) {
      throw new EnvironmentRecipeNameUnavailableError(input.config.name);
    }

    const inserted = await tx
      .insert(environments)
      .values({
        userId: undefined,
        createdByUserId: input.createdByUserId,
        name: input.config.name,
        description: input.config.description,
        config: input.config,
        // Unresolved candidates are never routable and intentionally have no
        // config-version history; finalization records version 1.
        isVerified: false,
        verificationTaskId: null,
        verificationError: null,
      })
      .returning({ id: environments.id, name: environments.name });

    const candidate = inserted[0];
    if (!candidate) {
      throw new Error('Failed to create the environment recipe candidate.');
    }

    return {
      environmentId: candidate.id,
      name: candidate.name,
      created: true,
    };
  });
}

type AcceptRecipeResolution = (
  recipe: EnvironmentRecipe,
  config: EnvironmentConfig,
) => string | null;

export type FinalizeEnvironmentRecipeResolutionInput = {
  environmentId: string;
  verificationTaskId: string;
  recipe: EnvironmentRecipe;
  /**
   * Control-adapter acceptance pinned-runtime/metadata/hash check, executed
   * inside the row lock. Returns null when the recipe is acceptable.
   */
  acceptRecipeResolution: AcceptRecipeResolution;
};

export type FinalizeEnvironmentRecipeResolutionResult =
  | { status: 'applied' }
  | { status: 'stale' }
  | { status: 'rejected'; reason: string };

/**
 * Persist a worker-resolved recipe through the trusted finalization path.
 * Unlike `updateEnvironmentDefinition`, this never clears or rewrites the
 * current verification binding and never touches repositories. Idempotent
 * for an identical resolution; stale runs and differing resolutions are
 * rejected.
 */
export async function finalizeEnvironmentRecipeResolution(
  dbOrTx: DatabaseOrTransaction,
  input: FinalizeEnvironmentRecipeResolutionInput,
): Promise<FinalizeEnvironmentRecipeResolutionResult> {
  return runInTransactionIfAvailable(dbOrTx, async (tx) => {
    const [current] = await tx
      .select({
        id: environments.id,
        name: environments.name,
        description: environments.description,
        config: environments.config,
        verificationTaskId: environments.verificationTaskId,
      })
      .from(environments)
      .where(eq(environments.id, input.environmentId))
      .for('update');

    if (!current) {
      return { status: 'rejected', reason: 'Environment not found.' };
    }

    if (current.verificationTaskId !== input.verificationTaskId) {
      // A newer verification attempt or an edit superseded this run.
      return { status: 'stale' };
    }

    const currentRecipe = current.config.environment_recipe;
    if (
      !currentRecipe ||
      currentRecipe.type !== input.recipe.type ||
      currentRecipe.schema_version !== input.recipe.schema_version ||
      currentRecipe.request_fingerprint !== input.recipe.request_fingerprint
    ) {
      return {
        status: 'rejected',
        reason: 'The request no longer matches this environment recipe.',
      };
    }

    const rejection = input.acceptRecipeResolution(
      input.recipe,
      current.config,
    );
    if (rejection) {
      return { status: 'rejected', reason: rejection };
    }

    const nextConfig: EnvironmentConfig = {
      ...current.config,
      environment_recipe: input.recipe,
    };

    if (currentRecipe.resolution) {
      // Identical-resolution retries stay successful; a differing resolution
      // is rejected rather than silently overwriting prior evidence.
      if (resolutionsMatch(currentRecipe.resolution, input.recipe.resolution)) {
        return { status: 'applied' };
      }
      return {
        status: 'rejected',
        reason:
          'A different resolution is already persisted for this recipe request.',
      };
    }

    await tx
      .update(environments)
      .set({ config: nextConfig })
      .where(eq(environments.id, input.environmentId));

    // The resolved configuration becomes history version 1; the unresolved
    // candidate never produced a history entry.
    await createEnvironmentConfigVersionSnapshot(tx, {
      environmentId: input.environmentId,
      config: nextConfig,
      name: current.name,
      description: current.description,
      source: 'setup',
    });

    return { status: 'applied' };
  });
}

/**
 * A verification task failed or was canceled before it could report a result
 * (for example a Docker/bootstrap failure before the agent harness started).
 * Mark the bound environment failed only when that task is still the current
 * attempt and no success has been recorded.
 */
export async function markEnvironmentVerificationFailedIfCurrent(
  dbOrTx: DatabaseOrTransaction,
  input: {
    environmentId: string;
    verificationTaskId: string;
    error: string;
  },
): Promise<{ marked: boolean }> {
  return runInTransactionIfAvailable(dbOrTx, async (tx) => {
    const [current] = await tx
      .select({
        id: environments.id,
        isVerified: environments.isVerified,
        verificationTaskId: environments.verificationTaskId,
        verificationError: environments.verificationError,
      })
      .from(environments)
      .where(eq(environments.id, input.environmentId))
      .for('update');

    if (!current || current.isVerified || current.verificationError) {
      return { marked: false };
    }

    if (current.verificationTaskId !== input.verificationTaskId) {
      return { marked: false };
    }

    await tx
      .update(environments)
      .set({
        isVerified: false,
        verifiedAt: null,
        verificationTaskId: current.verificationTaskId,
        verificationError: input.error.slice(0, 2_000),
      })
      .where(eq(environments.id, input.environmentId));

    return { marked: true };
  });
}
