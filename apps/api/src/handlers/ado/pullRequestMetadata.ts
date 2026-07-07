import { buildPullRequestUrl } from '@roomote/types';

import type { AdoPullRequestResource, AdoPullRequestWebhook } from './types';

type AdoResourceContainers = AdoPullRequestWebhook['resourceContainers'];

function getAdoBaseUrl(
  resourceContainers: AdoResourceContainers,
): string | undefined {
  return (
    resourceContainers?.account?.baseUrl ??
    resourceContainers?.collection?.baseUrl
  );
}

function getAdoOrganization({
  resourceContainers,
  pullRequest,
}: {
  resourceContainers: AdoResourceContainers;
  pullRequest: AdoPullRequestResource;
}): string {
  const baseUrl = getAdoBaseUrl(resourceContainers);

  if (baseUrl) {
    try {
      const parsed = new URL(baseUrl);
      const pathOrganization = parsed.pathname.split('/').filter(Boolean)[0];

      if (pathOrganization) {
        return decodeURIComponent(pathOrganization);
      }

      if (parsed.hostname.endsWith('.visualstudio.com')) {
        return parsed.hostname.split('.')[0] ?? parsed.hostname;
      }
    } catch {
      // Fall through to repository URLs below.
    }
  }

  const repositoryUrl =
    pullRequest.repository.webUrl ??
    pullRequest.repository.remoteUrl ??
    pullRequest.repository.url;

  if (repositoryUrl) {
    try {
      const parsed = new URL(repositoryUrl);

      if (parsed.hostname.endsWith('.visualstudio.com')) {
        return parsed.hostname.split('.')[0] ?? parsed.hostname;
      }

      const pathOrganization = parsed.pathname.split('/').filter(Boolean)[0];

      if (pathOrganization) {
        return decodeURIComponent(pathOrganization);
      }
    } catch {
      // Fall through to the final deterministic fallback.
    }
  }

  return 'unknown';
}

function getAdoHost(
  resourceContainers: AdoResourceContainers,
): string | undefined {
  const baseUrl = getAdoBaseUrl(resourceContainers);

  if (!baseUrl) {
    return undefined;
  }

  try {
    return new URL(baseUrl).host;
  } catch {
    return undefined;
  }
}

export function stripAdoGitRefPrefix(
  refName: string | undefined,
): string | undefined {
  return refName?.replace(/^refs\/heads\//, '');
}

export function getAdoPullRequestRepositoryFullName({
  resourceContainers,
  pullRequest,
}: {
  resourceContainers: AdoResourceContainers;
  pullRequest: AdoPullRequestResource;
}): string {
  return [
    getAdoOrganization({ resourceContainers, pullRequest }),
    pullRequest.repository.project.name,
    pullRequest.repository.name,
  ].join('/');
}

export function getAdoPullRequestHeadSha(
  pullRequest: AdoPullRequestResource,
): string {
  return (
    pullRequest.lastMergeSourceCommit?.commitId ??
    pullRequest.commits?.find((commit) => commit.commitId)?.commitId ??
    ''
  );
}

export function getAdoPullRequestUrl({
  resourceContainers,
  pullRequest,
  repositoryFullName,
}: {
  resourceContainers: AdoResourceContainers;
  pullRequest: AdoPullRequestResource;
  repositoryFullName: string;
}): string {
  return (
    pullRequest._links?.web?.href ??
    buildPullRequestUrl({
      provider: 'ado',
      host: getAdoHost(resourceContainers),
      repositoryFullName,
      number: pullRequest.pullRequestId,
    })
  );
}
