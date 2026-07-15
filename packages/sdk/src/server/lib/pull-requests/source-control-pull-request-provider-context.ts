import {
  buildAdoOrganizationApiBaseUrl,
  resolveAdoBaseUrl,
  resolveAdoToken,
} from '@roomote/ado';
import {
  buildBitbucketApiBaseUrl,
  resolveBitbucketAuth,
} from '@roomote/bitbucket';
import {
  buildGiteaApiBaseUrl,
  resolveGiteaBaseUrl,
  resolveGiteaToken,
} from '@roomote/gitea';
import {
  buildGitLabApiBaseUrl,
  resolveGitLabBaseUrl,
  resolveGitLabToken,
} from '@roomote/gitlab';
import {
  parseAdoRepositoryFullName,
  splitRepositoryFullName,
  type RepositoryRow,
} from './source-control-pull-request-shared';

/**
 * Operation vocabulary used only in credential-missing error text so read,
 * write, and create/update surfaces can share resolvers without changing the
 * messages callers and tests already rely on.
 */
type SourceControlApiPurpose = 'read' | 'write' | 'create';

function purposeVerb(purpose: SourceControlApiPurpose): string {
  return purpose;
}

export async function resolveGitLabProviderContext(
  repository: RepositoryRow,
  purpose: SourceControlApiPurpose,
): Promise<{ projectId: string; token: string; apiBaseUrl: string }> {
  if (!repository.externalRepoId) {
    throw new Error(
      `GitLab repository ${repository.fullName} is missing an external project id.`,
    );
  }

  const token = await resolveGitLabToken();
  if (!token) {
    throw new Error(
      `GITLAB_TOKEN is required to ${purposeVerb(purpose)} GitLab merge requests.`,
    );
  }

  const apiBaseUrl = buildGitLabApiBaseUrl(await resolveGitLabBaseUrl());

  return { projectId: repository.externalRepoId, token, apiBaseUrl };
}

export async function resolveGiteaProviderContext(
  repository: RepositoryRow,
  purpose: SourceControlApiPurpose,
): Promise<{
  apiBaseUrl: string;
  baseUrl: string;
  owner: string;
  repo: string;
  token: string;
}> {
  const token = await resolveGiteaToken();
  if (!token) {
    throw new Error(
      `GITEA_TOKEN is required to ${purposeVerb(purpose)} Gitea pull requests.`,
    );
  }

  const baseUrl = await resolveGiteaBaseUrl();
  if (!baseUrl) {
    throw new Error(
      `GITEA_BASE_URL is required to ${purposeVerb(purpose)} Gitea pull requests.`,
    );
  }

  const [owner, repo] = splitRepositoryFullName(repository.fullName, 'gitea');

  return {
    apiBaseUrl: buildGiteaApiBaseUrl(baseUrl),
    baseUrl,
    owner,
    repo,
    token,
  };
}

export async function resolveBitbucketProviderContext(
  repository: RepositoryRow,
  purpose: SourceControlApiPurpose,
): Promise<{
  apiBaseUrl: string;
  authHeader: string;
  baseUrl: string;
  workspace: string;
  repo: string;
}> {
  // Keep the shared purpose parameter for the provider-context contract; the
  // OAuth resolver owns the credential error text now.
  void purpose;
  const auth = await resolveBitbucketAuth();
  const { baseUrl, token } = auth;
  const [workspace, repo] = splitRepositoryFullName(
    repository.fullName,
    'bitbucket',
  );

  return {
    apiBaseUrl: buildBitbucketApiBaseUrl(baseUrl),
    authHeader:
      auth.authScheme === 'bearer'
        ? `Bearer ${token}`
        : `Basic ${Buffer.from(`${auth.username}:${token}`, 'utf8').toString('base64')}`,
    baseUrl,
    workspace,
    repo,
  };
}

export async function resolveAdoProviderContext(
  repository: RepositoryRow,
  purpose: SourceControlApiPurpose,
): Promise<{
  baseUrl: string;
  organizationApiBaseUrl: string;
  repositoryPullRequestsPath: string;
  token: string;
}> {
  if (!repository.externalRepoId) {
    throw new Error(
      `Azure DevOps repository ${repository.fullName} is missing an external repository id.`,
    );
  }

  const token = await resolveAdoToken();
  if (!token) {
    throw new Error(
      `ADO_TOKEN is required to ${purposeVerb(purpose)} Azure DevOps pull requests.`,
    );
  }

  const { organization, project } = parseAdoRepositoryFullName(
    repository.fullName,
  );
  const baseUrl = await resolveAdoBaseUrl();
  const organizationApiBaseUrl = buildAdoOrganizationApiBaseUrl({
    baseUrl,
    organization,
  });
  const repositoryPullRequestsPath = `/${encodeURIComponent(
    project,
  )}/_apis/git/repositories/${encodeURIComponent(
    repository.externalRepoId,
  )}/pullrequests`;

  return { baseUrl, organizationApiBaseUrl, repositoryPullRequestsPath, token };
}
