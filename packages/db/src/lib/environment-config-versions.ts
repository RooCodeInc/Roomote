import { desc, eq, sql } from 'drizzle-orm';

import type { EnvironmentConfig } from '@roomote/types';

import type { DatabaseOrTransaction } from '../db';
import {
  environmentConfigVersions,
  type EnvironmentConfigVersionSource,
} from '../schema';

export type CreateEnvironmentConfigVersionInput = {
  environmentId: string;
  config: EnvironmentConfig;
  name: string;
  description?: string | null;
  source: EnvironmentConfigVersionSource;
  createdByUserId?: string | null;
};

export async function createEnvironmentConfigVersionSnapshot(
  dbOrTx: DatabaseOrTransaction,
  input: CreateEnvironmentConfigVersionInput,
) {
  await dbOrTx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`environment-config-version:${input.environmentId}`}))`,
  );

  const [latestVersion] = await dbOrTx
    .select({
      version: environmentConfigVersions.version,
      config: environmentConfigVersions.config,
      name: environmentConfigVersions.name,
      description: environmentConfigVersions.description,
    })
    .from(environmentConfigVersions)
    .where(eq(environmentConfigVersions.environmentId, input.environmentId))
    .orderBy(desc(environmentConfigVersions.version))
    .limit(1);

  if (
    latestVersion &&
    latestVersion.name === input.name &&
    latestVersion.description === (input.description ?? null) &&
    JSON.stringify(latestVersion.config) === JSON.stringify(input.config)
  ) {
    return latestVersion;
  }

  const [createdVersion] = await dbOrTx
    .insert(environmentConfigVersions)
    .values({
      environmentId: input.environmentId,
      version: (latestVersion?.version ?? 0) + 1,
      config: input.config,
      name: input.name,
      description: input.description ?? null,
      source: input.source,
      createdByUserId: input.createdByUserId ?? null,
    })
    .returning();

  return createdVersion;
}
