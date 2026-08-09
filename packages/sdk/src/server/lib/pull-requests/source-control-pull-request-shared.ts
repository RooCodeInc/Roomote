import {
  and,
  db,
  environments,
  eq,
  repositories,
  type TaskRun,
} from '@roomote/db/server';
import {
  ALL_REPOSITORIES,
  environmentConfigSchema,
  getSourceControlProviderLabel,
  normalizeSourceControlProvider,
  resolveRepositoryProvidersFromPayload,
  resolveSourceControlHostFromPayload,
  resolveSourceControlProviderFromPayload,
  type SourceControlProvider,
} from '@roomote/types';
import { isGitLabOAuthAccessToken } from '@roomote/gitlab';

export type FetchImpl = typeof fetch;

export function buildGitLabTokenHeader(token: string): {
  name: string;
  value: string;
} {
  return isGitLabOAuthAccessToken(token)
    ? { name: 'Authorization', value: `Bearer ${token}` }
    : { name: 'PRIVATE-TOKEN', value: token };
}

export type RepositoryRow = {
  id: string;
  sourceControlProvider: SourceControlProvider;
  host: string | null;
  installationId: string | null;
  externalRepoId: string | null;
  fullName: string;
  htmlUrl: string;
  private?: boolean;
};

export function resolveSourceControlProviderForRepositoryFromPayload(
  payload: Record<string, unknown>,
  repositoryFullName: string,
): SourceControlProvider {
  const repositoryProviders = resolveRepositoryProvidersFromPayload(payload);

  if (repositoryProviders) {
    const repositoryProvider = repositoryProviders[repositoryFullName];

    if (repositoryProvider === undefined) {
      throw new Error(
        `Repository ${repositoryFullName} is not mapped to a source control provider.`,
      );
    }

    return normalizeSourceControlProvider(repositoryProvider);
  }

  return resolveSourceControlProviderFromPayload(payload);
}

export function resolveSourceControlHostForRepositoryFromPayload(
  payload: Record<string, unknown>,
  repositoryFullName: string,
): string | undefined {
  const repositoryProviders = resolveRepositoryProvidersFromPayload(payload);

  if (repositoryProviders?.[repositoryFullName] !== undefined) {
    return undefined;
  }

  const repositoryProvider =
    resolveSourceControlProviderForRepositoryFromPayload(
      payload,
      repositoryFullName,
    );
  const primaryProvider = resolveSourceControlProviderFromPayload(payload);

  return repositoryProvider === primaryProvider
    ? resolveSourceControlHostFromPayload(payload)
    : undefined;
}

/**
 * Shared provider-resolution and name/url plumbing for the provider-neutral
 * source-control pull-request surface. HTTP transport lives in
 * `source-control-pull-request-http.ts`; credential resolve lives in
 * `source-control-pull-request-provider-context.ts`; create-or-update branch
 * lookup lives in `source-control-pull-request-branch-lookup.ts`; normalized
 * open/merged listing stays owned by `source-control-pull-request-reads.ts`.
 */

/**
 * Resolves the active repository row for a (provider, fullName) identity,
 * optionally narrowed by source-control instance host.
 *
 * When `host` is provided (typically from the task payload's
 * `sourceControlHost`), only rows whose `host` matches exactly qualify.
 *
 * Without a `host`, a (provider, fullName) identity active on more than one
 * row is an error rather than an arbitrary pick: same-name repositories on
 * multiple hosts (self-managed GitLab/Gitea/ADO instances) could otherwise
 * silently resolve to the wrong instance. Launch sites disambiguate by
 * stamping `sourceControlHost` into the task payload.
 */
export async function resolveRepositoryRow({
  provider,
  repositoryFullName,
  host,
}: {
  provider: SourceControlProvider;
  repositoryFullName: string;
  host?: string;
}): Promise<RepositoryRow> {
  const rows = await db.query.repositories.findMany({
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
      private: true,
    },
  });

  if (host !== undefined) {
    const candidates = rows.filter((row) => row.host === host);

    if (candidates.length === 0) {
      throw new Error(
        `${getSourceControlProviderLabel(
          provider,
        )} repository not found or inactive on ${host}: ${repositoryFullName}`,
      );
    }

    if (candidates.length > 1) {
      throw new Error(
        `${getSourceControlProviderLabel(
          provider,
        )} repository ${repositoryFullName} matches more than one active repository on ${host}.`,
      );
    }

    return candidates[0]!;
  }

  if (rows.length === 0) {
    throw new Error(
      `${getSourceControlProviderLabel(
        provider,
      )} repository not found or inactive: ${repositoryFullName}`,
    );
  }

  if (rows.length > 1) {
    const hosts = [
      ...new Set(rows.map((row) => row.host ?? 'unknown host')),
    ].sort((left, right) => left.localeCompare(right));
    throw new Error(
      `${getSourceControlProviderLabel(
        provider,
      )} repository ${repositoryFullName} is linked from multiple hosts (${hosts.join(
        ', ',
      )}); the task payload must carry sourceControlHost to disambiguate.`,
    );
  }

  return rows[0]!;
}

export async function assertRepositoryInTaskRunScope(
  taskRun: TaskRun,
  repositoryFullName: string,
): Promise<void> {
  const scopedRepositories = await resolveTaskRunRepositoryScope(taskRun);

  if (scopedRepositories === null) {
    return;
  }

  if (!scopedRepositories.includes(repositoryFullName)) {
    throw new Error(
      `Repository ${repositoryFullName} is outside this task's source-control scope.`,
    );
  }
}

async function resolveTaskRunRepositoryScope(
  taskRun: TaskRun,
): Promise<string[] | null> {
  const payload = getPayloadRecord(taskRun.payload);
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
        `Environment not found for task run ${taskRun.id}: ${environmentId}`,
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
