import {
  buildAdoOrganizationApiBaseUrl,
  resolveAdoBaseUrl,
  resolveAdoToken,
} from '@roomote/ado';
import {
  buildBitbucketApiBaseUrl,
  resolveBitbucketBaseUrl,
  resolveBitbucketToken,
  resolveBitbucketUsername,
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
export type SourceControlApiPurpose = 'read' | 'write' | 'create';

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
  const token = await resolveBitbucketToken();
  if (!token) {
    throw new Error(
      `BITBUCKET_TOKEN is required to ${purposeVerb(purpose)} Bitbucket pull requests.`,
    );
  }

  const username = await resolveBitbucketUsername();
  if (!username) {
    throw new Error(
      `BITBUCKET_USERNAME is required to ${purposeVerb(purpose)} Bitbucket pull requests.`,
    );
  }

  const baseUrl = await resolveBitbucketBaseUrl();
  const [workspace, repo] = splitRepositoryFullName(
    repository.fullName,
    'bitbucket',
  );

  return {
    apiBaseUrl: buildBitbucketApiBaseUrl(baseUrl),
    authHeader: `Basic ${Buffer.from(`${username}:${token}`, 'utf8').toString('base64')}`,
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
