import {
  and,
  db,
  environmentRepositoryMappings,
  environments,
  eq,
  isNull,
  repositories,
} from '@roomote/db/server';

/** An environment the Fast Session can delegate a task to. */
export interface RoutableEnvironment {
  id: string;
  name: string;
  description?: string;
  repositories?: Array<{ id: string; name: string }>;
  repositoryNames: string[];
}

/** Where a launch runs: one named environment, or every repository. */
export type RoutingWorkspace =
  | { type: 'environment'; id: string; name: string }
  | { type: 'all_repositories' };

/** Every shared, non-eval environment with the repositories it maps. */
export async function getAvailableEnvironments(): Promise<
  RoutableEnvironment[]
> {
  const envs = await db
    .select({
      id: environments.id,
      name: environments.name,
      description: environments.description,
    })
    .from(environments)
    .where(and(eq(environments.isEval, false), isNull(environments.userId)));

  // Get repository names for each environment.
  const result: RoutableEnvironment[] = [];

  for (const env of envs) {
    const mappings = await db
      .select({
        repoId: repositories.id,
        repoName: repositories.fullName,
      })
      .from(environmentRepositoryMappings)
      .innerJoin(
        repositories,
        eq(environmentRepositoryMappings.repositoryId, repositories.id),
      )
      .where(eq(environmentRepositoryMappings.environmentId, env.id));

    result.push({
      id: env.id,
      name: env.name,
      description: env.description ?? undefined,
      repositories: mappings.map((mapping) => ({
        id: mapping.repoId,
        name: mapping.repoName,
      })),
      repositoryNames: mappings.map((m) => m.repoName),
    });
  }

  return result;
}
