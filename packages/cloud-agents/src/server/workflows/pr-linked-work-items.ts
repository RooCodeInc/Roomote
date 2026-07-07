import type { LinkedWorkItem } from '@roomote/types';

type GitHubClosingIssueReference = {
  number: number;
  url?: string;
  repository?: {
    name?: string;
  };
};

function parseGitHubIssueUrl(url?: string): {
  repository?: string;
  issueNumber?: string;
} {
  if (!url) {
    return {};
  }

  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(
      /^\/(?<owner>[^/]+)\/(?<repo>[^/]+)\/issues\/(?<issueNumber>\d+)(?:\/.*)?$/,
    );

    if (!match?.groups) {
      return {};
    }

    return {
      repository: `${match.groups.owner}/${match.groups.repo}`,
      issueNumber: match.groups.issueNumber,
    };
  } catch {
    return {};
  }
}

function normalizeGitHubIssueNumber(item: LinkedWorkItem): string {
  const parsedUrl = parseGitHubIssueUrl(item.url);
  const fromIdentifier = item.identifier.match(
    /(?:(?:[^/#]+\/[^/#]+)?#)?(\d+)$/,
  );

  return parsedUrl.issueNumber ?? fromIdentifier?.[1] ?? item.identifier;
}

function normalizeGitHubRepository(item: LinkedWorkItem): string | undefined {
  return item.repository ?? parseGitHubIssueUrl(item.url).repository;
}

function renderLinkedWorkItemReference(item: LinkedWorkItem): string {
  switch (item.provider) {
    case 'github': {
      const issueNumber = normalizeGitHubIssueNumber(item);
      const repository = normalizeGitHubRepository(item);

      return repository
        ? `Closes ${repository}#${issueNumber}`
        : `Closes #${issueNumber}`;
    }
    case 'gitlab':
      return item.url ? `Closes ${item.url}` : `Closes ${item.identifier}`;
    case 'linear':
      return `Closes ${item.identifier}`;
    case 'jira':
      return `Refs ${item.identifier}`;
    case 'asana':
      return item.url ? `Task: ${item.url}` : `Task: ${item.identifier}`;
  }
}

export function mergeLinkedWorkItems(
  ...collections: Array<LinkedWorkItem[] | undefined>
): LinkedWorkItem[] {
  const deduped = new Map<string, LinkedWorkItem>();

  for (const collection of collections) {
    if (!collection) {
      continue;
    }

    for (const item of collection) {
      const key = [
        item.provider,
        item.identifier,
        item.repository ?? '',
        item.url ?? '',
      ].join('|');

      if (!deduped.has(key)) {
        deduped.set(key, item);
      }
    }
  }

  return [...deduped.values()];
}

export function renderLinkedWorkItemsSection(
  linkedWorkItems?: LinkedWorkItem[],
): string | undefined {
  const mergedItems = mergeLinkedWorkItems(linkedWorkItems);

  if (mergedItems.length === 0) {
    return undefined;
  }

  const lines = mergedItems.map(renderLinkedWorkItemReference);

  return ['## Linked work items', '', ...lines].join('\n');
}

export function getGitHubLinkedWorkItemsFromClosingIssues({
  closingIssuesReferences,
  fallbackRepository,
}: {
  closingIssuesReferences: GitHubClosingIssueReference[];
  fallbackRepository: string;
}): LinkedWorkItem[] {
  return closingIssuesReferences.map((issue) => {
    const parsedUrl = parseGitHubIssueUrl(issue.url);

    return {
      provider: 'github',
      identifier: String(issue.number),
      url: issue.url,
      repository: parsedUrl.repository ?? fallbackRepository,
    } satisfies LinkedWorkItem;
  });
}
