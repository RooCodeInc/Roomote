import { asc, db, environmentRepositoryMappings, eq } from '@roomote/db/server';

/** Resolve a stable mapped environment from an already-disambiguated repo row. */
export async function resolveMappedEnvironmentId(
  repositoryId: string,
): Promise<string | null> {
  const mappings = await db
    .select({
      environmentId: environmentRepositoryMappings.environmentId,
    })
    .from(environmentRepositoryMappings)
    .where(eq(environmentRepositoryMappings.repositoryId, repositoryId))
    .orderBy(asc(environmentRepositoryMappings.environmentId));

  return mappings[0]?.environmentId ?? null;
}
