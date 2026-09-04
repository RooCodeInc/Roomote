type SessionPullRequest = {
  repository: string;
  number: number;
  url: string;
};

const TERMINAL_PULL_REQUEST_STATUSES = new Set(['closed', 'merged']);

export function getSessionPullRequests(
  tasks: Array<{
    pullRequests: Array<{
      repository: string | null;
      number: number | null;
      url: string;
      status: string | null;
    }>;
  }>,
): SessionPullRequest[] {
  const pullRequests: SessionPullRequest[] = [];
  const identities = new Set<string>();
  const urls = new Set<string>();

  for (const task of tasks) {
    for (const pullRequest of task.pullRequests) {
      if (
        !pullRequest.repository ||
        pullRequest.number === null ||
        (pullRequest.status &&
          TERMINAL_PULL_REQUEST_STATUSES.has(pullRequest.status))
      ) {
        continue;
      }

      const identity = `${pullRequest.repository.toLowerCase()}:${pullRequest.number}`;
      const url = pullRequest.url.trim();
      if (identities.has(identity) || urls.has(url)) continue;

      identities.add(identity);
      urls.add(url);
      pullRequests.push({
        repository: pullRequest.repository,
        number: pullRequest.number,
        url,
      });
    }
  }

  return pullRequests;
}
