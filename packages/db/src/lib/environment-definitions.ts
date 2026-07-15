import type { EnvironmentConfig } from '@roomote/types';
import { eq } from 'drizzle-orm';

import type { DatabaseOrTransaction } from '../db';
import { environmentRepositoryMappings, environments } from '../schema';
import {
  createEnvironmentConfigVersionSnapshot,
  type CreateEnvironmentConfigVersionInput,
} from './environment-config-versions';
import { softDeleteEnvironmentSnapshots } from './environment-snapshots';
import { runInTransactionIfAvailable } from './transaction-utils';

type EnvironmentDefinitionFields = {
  name?: string;
  description?: string | null;
  config?: EnvironmentConfig;
};

type UpdateEnvironmentDefinitionInput = {
  environmentId: string;
  fields: EnvironmentDefinitionFields;
  updatedAt?: Date;
  repositoryIds?: string[];
  configVersion?: Omit<CreateEnvironmentConfigVersionInput, 'environmentId'>;
  /**
   * When true, a runtime-affecting edit does not clear verification. Reserved
   * for the declarative (file-managed) path, whose environments are treated as
   * verified and never run the onboarding verification task.
   */
  preserveVerification?: boolean;
};

type UpdateEnvironmentDefinitionResult = {
  updated: boolean;
  snapshotsInvalidated: boolean;
  /**
   * True when the update was a runtime-affecting edit that cleared verification
   * (config or repository-mapping change, and `preserveVerification` was not
   * set). Callers can use this to re-register a fresh verification attempt.
   */
  verificationCleared: boolean;
};

/**
 * Fields applied to reset an environment back to the unverified/configured
 * state. Used both when a runtime-affecting edit invalidates a prior
 * verification and when a fresh verification retry starts.
 *
 * Clearing `verificationTaskId` invalidates any in-flight verification attempt:
 * because `recordEnvironmentVerification` rejects a null/mismatched task id, a
 * stale verification task cannot record a result against an edited
 * configuration.
 */
const VERIFICATION_RESET_FIELDS = {
  isVerified: false,
  verifiedAt: null,
  verificationError: null,
  verificationTaskId: null,
} as const;

function hasOwnKey<T extends object, K extends PropertyKey>(
  value: T,
  key: K,
): value is T & Record<K, unknown> {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableJsonValue);
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
        .map(([key, entryValue]) => [key, stableJsonValue(entryValue)]),
    );
  }

  return value;
}

function configsMatch(left: unknown, right: unknown): boolean {
  return (
    JSON.stringify(stableJsonValue(left)) ===
    JSON.stringify(stableJsonValue(right))
  );
}

function stringSetsMatch(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();

  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

export async function updateEnvironmentDefinition(
  dbOrTx: DatabaseOrTransaction,
  input: UpdateEnvironmentDefinitionInput,
): Promise<UpdateEnvironmentDefinitionResult> {
  return runInTransactionIfAvailable(dbOrTx, (tx) =>
    updateEnvironmentDefinitionLocked(tx, input),
  );
}

async function updateEnvironmentDefinitionLocked(
  dbOrTx: DatabaseOrTransaction,
  input: UpdateEnvironmentDefinitionInput,
): Promise<UpdateEnvironmentDefinitionResult> {
  const now = input.updatedAt ?? new Date();

  const [currentEnvironment] = await dbOrTx
    .select({
      name: environments.name,
      description: environments.description,
      config: environments.config,
    })
    .from(environments)
    .where(eq(environments.id, input.environmentId))
    .for('update');

  if (!currentEnvironment) {
    return {
      updated: false,
      snapshotsInvalidated: false,
      verificationCleared: false,
    };
  }

  const changedFields: EnvironmentDefinitionFields = {};

  if (
    hasOwnKey(input.fields, 'name') &&
    input.fields.name !== undefined &&
    input.fields.name !== currentEnvironment.name
  ) {
    changedFields.name = input.fields.name;
  }

  if (
    hasOwnKey(input.fields, 'description') &&
    input.fields.description !== undefined &&
    (input.fields.description ?? null) !==
      (currentEnvironment.description ?? null)
  ) {
    changedFields.description = input.fields.description;
  }

  if (
    hasOwnKey(input.fields, 'config') &&
    input.fields.config !== undefined &&
    !configsMatch(input.fields.config, currentEnvironment.config)
  ) {
    changedFields.config = input.fields.config;
  }

  let repositoryIdsChanged = false;

  if (input.repositoryIds !== undefined) {
    const currentMappings = await dbOrTx
      .select({ repositoryId: environmentRepositoryMappings.repositoryId })
      .from(environmentRepositoryMappings)
      .where(
        eq(environmentRepositoryMappings.environmentId, input.environmentId),
      );

    repositoryIdsChanged = !stringSetsMatch(
      input.repositoryIds,
      currentMappings.map((mapping) => mapping.repositoryId),
    );
  }

  const hasEnvironmentFieldChanges =
    Object.keys(changedFields).length > 0 || repositoryIdsChanged;

  if (!hasEnvironmentFieldChanges) {
    return {
      updated: false,
      snapshotsInvalidated: false,
      verificationCleared: false,
    };
  }

  // A runtime-affecting edit is any change to the config JSON (repositories,
  // install/setup commands, services and start commands, environment
  // variables, MCP/runtime configuration, snapshot or compute configuration)
  // or to the repository mappings. Metadata-only edits (name/description
  // handled through `changedFields` without a config change) must preserve
  // verification. Centralizing this here keeps the API, Settings, agent, and
  // declarative write paths from drifting.
  const isRuntimeAffectingEdit =
    changedFields.config !== undefined || repositoryIdsChanged;
  const verificationCleared =
    isRuntimeAffectingEdit && !input.preserveVerification;

  await dbOrTx
    .update(environments)
    .set({
      ...changedFields,
      ...(verificationCleared ? VERIFICATION_RESET_FIELDS : {}),
      updatedAt: now,
    })
    .where(eq(environments.id, input.environmentId));

  await softDeleteEnvironmentSnapshots(dbOrTx, {
    environmentId: input.environmentId,
    updatedAt: now,
  });

  if (input.configVersion) {
    await createEnvironmentConfigVersionSnapshot(dbOrTx, {
      environmentId: input.environmentId,
      ...input.configVersion,
    });
  }

  if (input.repositoryIds !== undefined && repositoryIdsChanged) {
    await dbOrTx
      .delete(environmentRepositoryMappings)
      .where(
        eq(environmentRepositoryMappings.environmentId, input.environmentId),
      );

    const mappings = input.repositoryIds.map((repositoryId) => ({
      environmentId: input.environmentId,
      repositoryId,
    }));

    if (mappings.length > 0) {
      await dbOrTx.insert(environmentRepositoryMappings).values(mappings);
    }
  }

  return { updated: true, snapshotsInvalidated: true, verificationCleared };
}

type RecordEnvironmentVerificationInput = {
  environmentId: string;
  verificationTaskId: string;
  success: boolean;
  /** Pre-sanitized, user-safe failure message. Only used when success=false. */
  error?: string | null;
  verifiedAt?: Date;
};

/**
 * Record the terminal result of an environment verification task.
 *
 * Only applies when `verificationTaskId` still matches the task currently
 * stored on the environment, so a stale or superseded verification attempt
 * cannot overwrite a newer one. Returns whether the row was updated.
 *
 * - success=true: marks the environment verified, sets `verifiedAt`, clears
 *   `verificationError`.
 * - success=false: leaves the environment usable but unverified and stores the
 *   sanitized failure message.
 */
export async function recordEnvironmentVerification(
  dbOrTx: DatabaseOrTransaction,
  input: RecordEnvironmentVerificationInput,
): Promise<{ recorded: boolean }> {
  return runInTransactionIfAvailable(dbOrTx, async (tx) => {
    const [current] = await tx
      .select({ verificationTaskId: environments.verificationTaskId })
      .from(environments)
      .where(eq(environments.id, input.environmentId))
      .for('update');

    if (!current) {
      return { recorded: false };
    }

    // Reject a mismatched verification task so a stale attempt cannot clobber
    // a newer one. The environment must currently point at this task.
    if (current.verificationTaskId !== input.verificationTaskId) {
      return { recorded: false };
    }

    if (input.success) {
      await tx
        .update(environments)
        .set({
          isVerified: true,
          verifiedAt: input.verifiedAt ?? new Date(),
          verificationError: null,
        })
        .where(eq(environments.id, input.environmentId));
    } else {
      await tx
        .update(environments)
        .set({
          isVerified: false,
          verifiedAt: null,
          verificationError: input.error ?? null,
        })
        .where(eq(environments.id, input.environmentId));
    }

    return { recorded: true };
  });
}

/**
 * Attach a (re)started verification task to an environment and reset it to the
 * unverified/configured state. A new retry replaces any prior
 * `verificationTaskId` and clears the previous error and verified timestamp.
 */
export async function beginEnvironmentVerification(
  dbOrTx: DatabaseOrTransaction,
  input: { environmentId: string; verificationTaskId: string },
): Promise<void> {
  await dbOrTx
    .update(environments)
    .set({
      ...VERIFICATION_RESET_FIELDS,
      verificationTaskId: input.verificationTaskId,
    })
    .where(eq(environments.id, input.environmentId));
}
