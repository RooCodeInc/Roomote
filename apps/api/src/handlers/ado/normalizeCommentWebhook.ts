import { getAdoPullRequest } from '@roomote/ado';

// Matches pull request resource links such as
// .../repositories/<repository-uuid>/pullRequests/<number>/threads/<id>
const ADO_PULL_REQUEST_LINK_PATTERN =
  /\/repositories\/([^/]+)\/pullRequests\/(\d+)(?:\/|$|\?)/i;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function getLinkHref(links: Record<string, unknown>, name: string): string {
  const link = asRecord(links[name]);

  return typeof link?.href === 'string' ? link.href : '';
}

function parsePullRequestRef(
  resource: Record<string, unknown>,
): { repositoryId: string; pullRequestNumber: number } | null {
  const links = asRecord(resource._links);

  if (!links) {
    return null;
  }

  for (const name of ['self', 'threads', 'pullRequests']) {
    const match = getLinkHref(links, name).match(ADO_PULL_REQUEST_LINK_PATTERN);

    if (match?.[1] && match[2]) {
      return {
        repositoryId: decodeURIComponent(match[1]),
        pullRequestNumber: Number(match[2]),
      };
    }
  }

  return null;
}

/**
 * Azure DevOps delivers `ms.vss-code.git-pullrequest-comment-event`
 * subscriptions with the comment object directly as `resource`, even at
 * `resourceVersion: 1.0` — not the documented
 * `resource: { comment, pullRequest }` nesting. When the flat shape
 * arrives, rehydrate the pull request from the resource links so the
 * documented shape reaches the schema and handler unchanged.
 */
export async function normalizeAdoCommentWebhookPayload(
  payload: unknown,
): Promise<unknown> {
  const root = asRecord(payload);
  const resource = asRecord(root?.resource);

  if (!root || !resource) {
    return payload;
  }

  if (asRecord(resource.comment) && asRecord(resource.pullRequest)) {
    return payload;
  }

  const pullRequestRef = parsePullRequestRef(resource);

  if (!pullRequestRef) {
    return payload;
  }

  const pullRequest = await getAdoPullRequest({
    repositoryId: pullRequestRef.repositoryId,
    pullRequestNumber: pullRequestRef.pullRequestNumber,
  });

  return {
    ...root,
    resource: {
      comment: resource,
      pullRequest,
    },
  };
}
