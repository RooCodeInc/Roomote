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
};

type UpdateEnvironmentDefinitionResult = {
  updated: boolean;
  snapshotsInvalidated: boolean;
};

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
    return { updated: false, snapshotsInvalidated: false };
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
    return { updated: false, snapshotsInvalidated: false };
  }

  await dbOrTx
    .update(environments)
    .set({
      ...changedFields,
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

  return { updated: true, snapshotsInvalidated: true };
}
