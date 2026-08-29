import type { MergeAnnouncerPushEvent } from '@roomote/sdk/server';

import { toHostFromUrl } from './utils';
import type { AdoPushWebhook } from './ado/types';
import type { BitbucketPushWebhook } from './bitbucket/types';
import type { GiteaPushWebhook } from './gitea/types';
import type { GitLabPushWebhook } from './gitlab/types';

type GitHubPushWebhook = {
  ref: string;
  deleted?: boolean;
  compare?: string | null;
  size?: number;
  commits?: Array<{
    id: string;
    message: string;
    url?: string | null;
    author?: {
      name?: string | null;
      username?: string | null;
      email?: string | null;
    } | null;
  }>;
  pusher?: { name?: string | null } | null;
  sender?: { login?: string | null } | null;
  repository?: {
    id: number;
    full_name: string;
    html_url?: string | null;
  };
};

export function normalizeGitHubPush(
  payload: GitHubPushWebhook,
): MergeAnnouncerPushEvent | null {
  if (!payload.repository || !payload.commits) {
    return null;
  }

  return {
    provider: 'github',
    ref: payload.ref,
    deleted: payload.deleted,
    compareUrl: payload.compare,
    commitCount: payload.size,
    commits: payload.commits,
    pusher: payload.pusher?.name ?? payload.sender?.login,
    repository: {
      externalId: String(payload.repository.id),
      fullName: payload.repository.full_name,
      host: toHostFromUrl(payload.repository.html_url ?? '') ?? 'github.com',
      htmlUrl: payload.repository.html_url,
    },
  };
}

const ZERO_SHA = /^0+$/u;

export function normalizeGitLabPush(
  payload: GitLabPushWebhook,
): MergeAnnouncerPushEvent {
  return {
    provider: 'gitlab',
    ref: payload.ref,
    deleted: ZERO_SHA.test(payload.after),
    compareUrl: payload.compare,
    commitCount: payload.total_commits_count,
    commits: payload.commits.map((commit) => ({
      id: commit.id,
      message: commit.message,
      url: commit.url,
      author: commit.author,
    })),
    pusher:
      payload.user_username ?? payload.user_name ?? payload.user_email ?? null,
    repository: {
      externalId: String(payload.project.id),
      fullName:
        payload.project.path_with_namespace ?? String(payload.project.id),
      host: toHostFromUrl(payload.project.web_url ?? ''),
      htmlUrl: payload.project.web_url,
    },
  };
}

export function normalizeGiteaPush(
  payload: GiteaPushWebhook,
): MergeAnnouncerPushEvent {
  return {
    provider: 'gitea',
    ref: payload.ref,
    deleted: payload.deleted,
    compareUrl: payload.compare_url,
    commits: payload.commits.map((commit) => ({
      id: commit.id,
      message: commit.message,
      url: commit.url,
      author: {
        name: commit.author?.name ?? commit.author?.full_name,
        username: commit.author?.username ?? commit.author?.login,
        email: commit.author?.email,
      },
    })),
    pusher:
      payload.pusher?.username ??
      payload.pusher?.login ??
      payload.pusher?.full_name ??
      payload.pusher?.name ??
      payload.sender?.login ??
      null,
    repository: {
      externalId: String(payload.repository.id),
      fullName: payload.repository.full_name,
      host: toHostFromUrl(payload.repository.html_url ?? ''),
      htmlUrl: payload.repository.html_url,
    },
  };
}

export function normalizeBitbucketPush(
  payload: BitbucketPushWebhook,
): MergeAnnouncerPushEvent[] {
  const externalId = String(
    payload.repository.uuid ??
      payload.repository.id ??
      payload.repository.full_name,
  );
  const htmlUrl = payload.repository.links?.html?.href;
  const pusher =
    payload.actor?.nickname ??
    payload.actor?.username ??
    payload.actor?.display_name ??
    null;

  return payload.push.changes.flatMap((change) => {
    const ref = change.new ?? change.old;
    if (!ref?.name || (ref.type && ref.type !== 'branch')) {
      return [];
    }

    return [
      {
        provider: 'bitbucket',
        ref: `refs/heads/${ref.name}`,
        deleted: change.closed === true || !change.new,
        compareUrl: change.links?.html?.href,
        commits: (change.commits ?? []).map((commit) => ({
          id: commit.hash,
          message: commit.message,
          url: commit.links?.html?.href,
          author: {
            name: commit.author?.user?.display_name ?? commit.author?.raw,
            username:
              commit.author?.user?.nickname ?? commit.author?.user?.username,
          },
        })),
        pusher,
        repository: {
          externalId,
          fullName: payload.repository.full_name,
          host: toHostFromUrl(htmlUrl ?? '') ?? 'bitbucket.org',
          htmlUrl,
        },
      } satisfies MergeAnnouncerPushEvent,
    ];
  });
}

export function normalizeAdoPush(
  payload: AdoPushWebhook,
): MergeAnnouncerPushEvent[] {
  const repositoryUrl =
    payload.resource.repository.webUrl ??
    payload.resource.repository.remoteUrl ??
    payload.resource.repository.url;
  const pusher =
    payload.resource.pushedBy?.displayName ??
    payload.resource.pushedBy?.uniqueName ??
    payload.resource.pushedBy?.id ??
    payload.resource.createdBy?.displayName ??
    payload.resource.createdBy?.uniqueName ??
    null;
  const organizationUrl =
    payload.resourceContainers?.account?.baseUrl ??
    payload.resourceContainers?.collection?.baseUrl;

  return payload.resource.refUpdates.map((update) => ({
    provider: 'ado',
    ref: update.name,
    deleted: update.isDelete || ZERO_SHA.test(update.newObjectId ?? ''),
    commits: payload.resource.commits.flatMap((commit) => {
      const id = commit.id ?? commit.commitId;
      if (!id) return [];
      return [
        {
          id,
          message: commit.message ?? commit.comment ?? 'Untitled commit',
          url: commit.url,
          author: {
            name: commit.author?.displayName ?? commit.author?.name,
            username: commit.author?.uniqueName,
            email: commit.author?.email,
          },
        },
      ];
    }),
    pusher,
    repository: {
      externalId: payload.resource.repository.id,
      fullName: `${payload.resource.repository.project.name}/${payload.resource.repository.name}`,
      host: toHostFromUrl(repositoryUrl ?? organizationUrl ?? ''),
      htmlUrl: repositoryUrl,
    },
  }));
}
