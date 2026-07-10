import {
  and,
  db,
  environments,
  eq,
  repositories,
  type Run,
} from '@roomote/db/server';
import {
  ALL_REPOSITORIES,
  environmentConfigSchema,
  getSourceControlProviderLabel,
  type SourceControlProvider,
} from '@roomote/types';

export type FetchImpl = typeof fetch;

export type RepositoryRow = {
  id: string;
  sourceControlProvider: SourceControlProvider;
  host: string | null;
  installationId: string | null;
  externalRepoId: string | null;
  fullName: string;
  htmlUrl: string;
};

/**
 * Shared provider-resolution and HTTP plumbing for the provider-neutral
 * source-control pull-request surface. The mutation, read, and write modules
 * each used to carry byte-identical private copies of these helpers; they now
 * import from this module so provider resolution and request handling change
 * in exactly one place.
 */

export async function resolveRepositoryRow({
  provider,
  repositoryFullName,
}: {
  provider: SourceControlProvider;
  repositoryFullName: string;
}): Promise<RepositoryRow> {
  const repository = await db.query.repositories.findFirst({
    where: and(
      eq(repositories.sourceControlProvider, provider),
      eq(repositories.fullName, repositoryFullName),
      eq(repositories.isActive, true),
    ),
    columns: {
      id: true,
      sourceControlProvider: true,
      host: true,
      installationId: true,
      externalRepoId: true,
      fullName: true,
      htmlUrl: true,
    },
  });

  if (!repository) {
    throw new Error(
      `${getSourceControlProviderLabel(
        provider,
      )} repository not found or inactive: ${repositoryFullName}`,
    );
  }

  return repository;
}

export async function assertRepositoryInCloudJobScope(
  cloudJob: Run,
  repositoryFullName: string,
): Promise<void> {
  const scopedRepositories = await resolveCloudJobRepositoryScope(cloudJob);

  if (scopedRepositories === null) {
    return;
  }

  if (!scopedRepositories.includes(repositoryFullName)) {
    throw new Error(
      `Repository ${repositoryFullName} is outside this task's source-control scope.`,
    );
  }
}

async function resolveCloudJobRepositoryScope(
  cloudJob: Run,
): Promise<string[] | null> {
  const payload = getPayloadRecord(cloudJob.payload);
  const environmentId =
    typeof payload.environmentId === 'string'
      ? payload.environmentId.trim()
      : '';

  if (environmentId) {
    const environment = await db.query.environments.findFirst({
      where: eq(environments.id, environmentId),
      columns: { config: true },
    });

    if (!environment) {
      throw new Error(
        `Environment not found for cloud job ${cloudJob.id}: ${environmentId}`,
      );
    }

    const parsed = environmentConfigSchema.safeParse(environment.config);

    if (!parsed.success) {
      throw new Error(
        `Environment ${environmentId} has an invalid repository configuration.`,
      );
    }

    return normalizeRepositoryScope(
      parsed.data.repositories.map((repository) => repository.repository),
    );
  }

  if (Array.isArray(payload.selectedRepositories)) {
    const selectedRepositories = normalizeRepositoryScope(
      payload.selectedRepositories.filter(
        (repository): repository is string => typeof repository === 'string',
      ),
    );

    if (selectedRepositories.length > 0) {
      return selectedRepositories;
    }
  }

  const repo = typeof payload.repo === 'string' ? payload.repo.trim() : '';
  if (repo && repo !== ALL_REPOSITORIES) {
    return [repo];
  }

  return null;
}

function normalizeRepositoryScope(repositoryNames: string[]): string[] {
  return [
    ...new Set(repositoryNames.map((name) => name.trim()).filter(Boolean)),
  ];
}

export function buildApiUrl(
  apiBaseUrl: string,
  path: string,
  params: Record<string, string | number | boolean>,
): string {
  const url = new URL(
    path.replace(/^\//, ''),
    `${apiBaseUrl.replace(/\/$/, '')}/`,
  );

  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }

  return url.toString();
}

export function splitRepositoryFullName(
  repositoryFullName: string,
  provider: SourceControlProvider,
): [string, string] {
  const [owner, repo, ...extra] = repositoryFullName.split('/');

  if (!owner || !repo || extra.length > 0) {
    throw new Error(
      `${getSourceControlProviderLabel(
        provider,
      )} repository names must be in owner/repo form: ${repositoryFullName}`,
    );
  }

  return [owner, repo];
}

export function parseAdoRepositoryFullName(repositoryFullName: string): {
  organization: string;
  project: string;
} {
  const [organization, project, repository, ...extra] =
    repositoryFullName.split('/');

  if (!organization || !project || !repository || extra.length > 0) {
    throw new Error(
      `Azure DevOps repository names must be in organization/project/repository form: ${repositoryFullName}`,
    );
  }

  return { organization, project };
}

export function buildAdoBasicAuthHeader(token: string): string {
  return `Basic ${Buffer.from(`:${token}`, 'utf8').toString('base64')}`;
}

export async function formatResponseBody(response: Response): Promise<string> {
  try {
    const body = await response.text();
    return body ? `: ${body.slice(0, 500)}` : '';
  } catch {
    return '';
  }
}

export function getPayloadRecord(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}

export function isDraftTitle(title: string | undefined): boolean {
  return /^(draft|wip):/i.test(title ?? '');
}

export function isGitLabDraft(mergeRequest: {
  draft?: boolean;
  work_in_progress?: boolean;
  title: string;
}): boolean {
  return (
    Boolean(mergeRequest.draft) ||
    Boolean(mergeRequest.work_in_progress) ||
    isDraftTitle(mergeRequest.title)
  );
}
