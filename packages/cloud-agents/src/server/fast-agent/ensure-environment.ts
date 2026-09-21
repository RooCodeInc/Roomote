import { ensureEnvironmentRecipeCandidate } from '@roomote/db/server';
import {
  ENVIRONMENT_RECIPE_SCHEMA_VERSION,
  type EnvironmentRecipe,
  type EnvironmentConfig,
} from '@roomote/types';

import { stableRecipeJsonSha256 } from '../environment-recipes';
import type { EnvironmentRecipeControlAdapter } from '../environment-recipes';

/**
 * Fast provisioning path for on-demand environment recipes. `preview` is
 * read-only; `create` is admin-only, idempotent by proposal fingerprint, and
 * the fingerprint binds the normalized request, agent-selected name, purpose,
 * setup-time bound, and persistence impact disclosed by the control adapter.
 */

type EnvironmentRecipeCandidateStatus =
  | 'configuring'
  | 'verifying'
  | 'failed'
  | 'ready';

type EnsureEnvironmentPreviewResult =
  | {
      status: 'ready';
      environmentId: string;
      name: string;
    }
  | {
      status: 'existing';
      environmentId: string;
      name: string;
      state: EnvironmentRecipeCandidateStatus;
      /** Bound proposal fingerprint for an identical transient retry. */
      proposalFingerprint: string;
      setupTimeBoundMinutes: number;
      persistenceImpact: string;
      impactSummary: string;
    }
  | {
      status: 'proposal';
      proposalFingerprint: string;
      setupTimeBoundMinutes: number;
      persistenceImpact: string;
      impactSummary: string;
    }
  | { status: 'name_unavailable'; name: string };

export type EnsureEnvironmentAvailableEnvironment = {
  id: string;
  name: string;
  isVerified?: boolean;
  verificationError?: string | null;
  config?: EnvironmentConfig;
};

type VerificationLaunchResult =
  | {
      success: true;
      taskId: string;
      taskUrl?: string;
      alreadyActive?: boolean;
    }
  | { success: false; error: string };

/**
 * Serialize recipe verification attempts independently from candidate
 * creation. An active attempt is reused, while a failed/completed attempt may
 * launch a genuinely new run with its own launch idempotency key.
 */
export async function launchEnvironmentRecipeVerification<TLockContext>(input: {
  environmentId: string;
  withLock: (
    environmentId: string,
    mutation: (context: TLockContext) => Promise<VerificationLaunchResult>,
  ) => Promise<VerificationLaunchResult>;
  findActiveTaskId: (
    context: TLockContext,
    environmentId: string,
  ) => Promise<string | null>;
  launch: () => Promise<VerificationLaunchResult>;
}): Promise<VerificationLaunchResult> {
  return input.withLock(input.environmentId, async (context) => {
    const activeTaskId = await input.findActiveTaskId(
      context,
      input.environmentId,
    );
    if (activeTaskId) {
      return {
        success: true,
        taskId: activeTaskId,
        alreadyActive: true,
      };
    }
    return input.launch();
  });
}

function candidateState(environment: {
  isVerified?: boolean;
  config?: EnvironmentConfig;
  verificationError?: string | null;
}): EnvironmentRecipeCandidateStatus {
  if (environment.isVerified) {
    return 'ready';
  }
  if (environment.verificationError) {
    return 'failed';
  }
  if (environment.config?.environment_recipe?.resolution) {
    return 'verifying';
  }
  return 'configuring';
}

function computeProposalFingerprint(input: {
  adapter: EnvironmentRecipeControlAdapter;
  request: { packages: string[] };
  requestFingerprint: string;
  name: string;
  purpose: string;
}): string {
  const description = input.adapter.describeSetupRequest(input.request);
  return stableRecipeJsonSha256({
    type: input.adapter.type,
    schema_version: ENVIRONMENT_RECIPE_SCHEMA_VERSION,
    request: input.request,
    request_fingerprint: input.requestFingerprint,
    name: input.name,
    purpose: input.purpose,
    setupTimeBoundMinutes: description.setupTimeBoundMinutes,
    persistenceImpact: description.persistenceImpact,
    impactSummary: description.impactSummary,
  });
}

export function previewEnsureEnvironment(input: {
  adapter: EnvironmentRecipeControlAdapter;
  request: { packages: string[] };
  name: string;
  purpose: string;
  environments: EnsureEnvironmentAvailableEnvironment[];
}): EnsureEnvironmentPreviewResult {
  const normalized = input.adapter.normalizeRequest(input.request);
  const requestFingerprint =
    input.adapter.computeRequestFingerprint(normalized);
  const named = input.environments.find(
    (environment) => environment.name === input.name,
  );
  const namedRecipeFingerprint =
    named?.config?.environment_recipe?.request_fingerprint;
  const namedIsSameCandidate =
    namedRecipeFingerprint !== undefined &&
    namedRecipeFingerprint === requestFingerprint;
  const namedIsCompatible = named
    ? input.adapter.isCompatible(
        {
          isVerified: named.isVerified,
          config: { environment_recipe: named.config?.environment_recipe },
        },
        normalized,
      )
    : false;
  if (named && !namedIsCompatible && !namedIsSameCandidate) {
    return { status: 'name_unavailable', name: input.name };
  }

  const comparisonEnvironments = input.environments;
  const compatible = comparisonEnvironments.find((environment) =>
    input.adapter.isCompatible(
      {
        isVerified: environment.isVerified,
        config: { environment_recipe: environment.config?.environment_recipe },
      },
      normalized,
    ),
  );
  if (compatible) {
    return {
      status: 'ready',
      environmentId: compatible.id,
      name: compatible.name,
    };
  }

  const description = input.adapter.describeSetupRequest(normalized);
  const proposalFingerprint = computeProposalFingerprint({
    adapter: input.adapter,
    request: normalized,
    requestFingerprint,
    name: input.name,
    purpose: input.purpose,
  });

  const candidate = input.environments.find(
    (environment) =>
      environment.config?.environment_recipe?.request_fingerprint ===
      requestFingerprint,
  );
  if (candidate) {
    return {
      status: 'existing',
      environmentId: candidate.id,
      name: candidate.name,
      state: candidateState(candidate),
      proposalFingerprint,
      setupTimeBoundMinutes: description.setupTimeBoundMinutes,
      persistenceImpact: description.persistenceImpact,
      impactSummary: description.impactSummary,
    };
  }

  return {
    status: 'proposal',
    proposalFingerprint,
    setupTimeBoundMinutes: description.setupTimeBoundMinutes,
    persistenceImpact: description.persistenceImpact,
    impactSummary: description.impactSummary,
  };
}

type CreateEnvironmentCandidateResult =
  | {
      success: true;
      environmentId: string;
      name: string;
      created: boolean;
    }
  | { success: false; error: string };

/**
 * Idempotently create or reuse the candidate for the proposal a human
 * confirmed. The fingerprint-keyed helper prevents concurrent duplicate
 * candidates and a failed enqueue leaves a resumable candidate, never a
 * second row.
 */
export async function createEnvironmentRecipeCandidate(input: {
  adapter: EnvironmentRecipeControlAdapter;
  request: { packages: string[] };
  name: string;
  purpose: string;
  proposalFingerprint: string;
  createdByUserId: string;
}): Promise<CreateEnvironmentCandidateResult> {
  const normalized = input.adapter.normalizeRequest(input.request);
  const requestFingerprint =
    input.adapter.computeRequestFingerprint(normalized);
  const expected = computeProposalFingerprint({
    adapter: input.adapter,
    request: normalized,
    requestFingerprint,
    name: input.name,
    purpose: input.purpose,
  });

  if (expected !== input.proposalFingerprint) {
    return {
      success: false,
      error:
        'The proposal fingerprint no longer matches the request, name, purpose, setup-time bound, and persistence impact. Re-run preview and confirm the current proposal.',
    };
  }

  const recipe: EnvironmentRecipe = {
    type: input.adapter.type,
    schema_version: ENVIRONMENT_RECIPE_SCHEMA_VERSION,
    request: normalized,
    request_fingerprint: requestFingerprint,
  };

  const config: EnvironmentConfig = {
    name: input.name,
    description: input.purpose.trim() || undefined,
    environment_recipe: recipe,
    repositories: [],
  };

  try {
    const result = await ensureEnvironmentRecipeCandidate({
      config,
      createdByUserId: input.createdByUserId,
    });
    return {
      success: true,
      environmentId: result.environmentId,
      name: result.name,
      created: result.created,
    };
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : 'Failed to ensure the environment candidate.',
    };
  }
}
