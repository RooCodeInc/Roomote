import { getInstallationOctokit } from '@roomote/github';

const TIMELINE_PAGE_SIZE = 100;
/** Bound webhook latency; most timelines finish within one page. */
const TIMELINE_MAX_PAGES = 3;

type GitHubLinkedReference = {
  kind: 'issue' | 'pull_request';
  number: number;
  title?: string;
  url?: string;
  state?: string;
  repository: string;
};

type TimelineIssueLike = {
  number?: number;
  title?: string | null;
  html_url?: string | null;
  state?: string | null;
  pull_request?: unknown;
  repository?: {
    full_name?: string | null;
    owner?: { login?: string | null } | null;
    name?: string | null;
  } | null;
};

type TimelineEventLike = {
  event?: string;
  source?: {
    type?: string;
    issue?: TimelineIssueLike;
  };
  subject?: TimelineIssueLike;
};

function repositoryFromIssue(
  issue: TimelineIssueLike,
  fallbackRepository: string,
): string {
  if (issue.repository?.full_name) {
    return issue.repository.full_name;
  }

  const owner = issue.repository?.owner?.login;
  const name = issue.repository?.name;
  if (owner && name) {
    return `${owner}/${name}`;
  }

  if (typeof issue.html_url === 'string') {
    try {
      const pathname = new URL(issue.html_url).pathname;
      const match = pathname.match(/^\/([^/]+)\/([^/]+)\/(?:issues|pull)\/\d+/);
      if (match?.[1] && match[2]) {
        return `${match[1]}/${match[2]}`;
      }
    } catch {
      // Fall through to the mention target repository.
    }
  }

  return fallbackRepository;
}

function toLinkedReference(
  issue: TimelineIssueLike | undefined,
  fallbackRepository: string,
): GitHubLinkedReference | null {
  if (typeof issue?.number !== 'number') {
    return null;
  }

  return {
    kind: issue.pull_request ? 'pull_request' : 'issue',
    number: issue.number,
    title: typeof issue.title === 'string' ? issue.title : undefined,
    url: typeof issue.html_url === 'string' ? issue.html_url : undefined,
    state: typeof issue.state === 'string' ? issue.state : undefined,
    repository: repositoryFromIssue(issue, fallbackRepository),
  };
}

function referenceKey(reference: GitHubLinkedReference): string {
  return `${reference.kind}:${reference.repository}#${reference.number}`;
}

function collectFromIssue(
  issue: TimelineIssueLike | undefined,
  fallbackRepository: string,
  excludeNumber: number,
  excludeRepository: string,
  byKey: Map<string, GitHubLinkedReference>,
): void {
  const reference = toLinkedReference(issue, fallbackRepository);
  if (!reference) {
    return;
  }

  if (
    reference.number === excludeNumber &&
    reference.repository === excludeRepository
  ) {
    return;
  }

  const key = referenceKey(reference);
  const existing = byKey.get(key);
  if (!existing) {
    byKey.set(key, reference);
    return;
  }

  // Prefer the first full snapshot; fill sparse fields from later events.
  byKey.set(key, {
    ...existing,
    title: existing.title ?? reference.title,
    url: existing.url ?? reference.url,
    state: existing.state ?? reference.state,
  });
}

/**
 * Collect issues and pull requests linked to a GitHub issue or PR via the
 * timeline (cross-references and development connections). Failures return an
 * empty list so mention handling is not blocked.
 */
export async function fetchGitHubLinkedReferences({
  installationId,
  repositoryFullName,
  issueOrPrNumber,
}: {
  installationId: number;
  repositoryFullName: string;
  issueOrPrNumber: number;
}): Promise<GitHubLinkedReference[]> {
  const [owner, repo] = repositoryFullName.split('/');
  if (!owner || !repo) {
    return [];
  }

  try {
    const octokit = await getInstallationOctokit({ installationId });
    const byKey = new Map<string, GitHubLinkedReference>();

    for (let page = 1; page <= TIMELINE_MAX_PAGES; page += 1) {
      const response = await octokit.request(
        'GET /repos/{owner}/{repo}/issues/{issue_number}/timeline',
        {
          owner,
          repo,
          issue_number: issueOrPrNumber,
          per_page: TIMELINE_PAGE_SIZE,
          page,
          headers: {
            accept: 'application/vnd.github+json',
          },
        },
      );

      const events = Array.isArray(response.data)
        ? (response.data as TimelineEventLike[])
        : [];

      for (const event of events) {
        if (event.event === 'cross-referenced') {
          collectFromIssue(
            event.source?.issue,
            repositoryFullName,
            issueOrPrNumber,
            repositoryFullName,
            byKey,
          );
        }

        if (event.event === 'connected' || event.event === 'disconnected') {
          // Connected events point at the other work item; ignore disconnects
          // for inclusion — later code only stores unique refs by number.
          if (event.event === 'connected') {
            collectFromIssue(
              event.subject,
              repositoryFullName,
              issueOrPrNumber,
              repositoryFullName,
              byKey,
            );
          }
        }
      }

      if (events.length < TIMELINE_PAGE_SIZE) {
        break;
      }
    }

    return [...byKey.values()].sort((a, b) => {
      if (a.repository !== b.repository) {
        return a.repository.localeCompare(b.repository);
      }
      if (a.kind !== b.kind) {
        return a.kind.localeCompare(b.kind);
      }
      return a.number - b.number;
    });
  } catch (error) {
    console.warn(
      `[fetchGitHubLinkedReferences] failed for ${repositoryFullName}#${issueOrPrNumber}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return [];
  }
}

/**
 * Prompt-facing summary of linked issues/PRs. Titles and bodies from linked
 * surfaces are escaped by callers that wrap untrusted blocks; this formatter
 * only emits structured metadata lines (title is included as data).
 */
export function formatGitHubLinkedReferencesSection(
  references: GitHubLinkedReference[],
): string | undefined {
  if (references.length === 0) {
    return undefined;
  }

  const lines = [
    'These source-control items are linked to the mention target via timeline cross-references or development connections:',
  ];

  for (const reference of references) {
    const kindLabel =
      reference.kind === 'pull_request' ? 'Pull request' : 'Issue';
    const refLabel = `${reference.repository}#${reference.number}`;
    const titlePart = reference.title?.trim()
      ? ` — ${reference.title.trim()}`
      : '';
    const statePart = reference.state ? ` [${reference.state}]` : '';
    const urlPart = reference.url ? ` (${reference.url})` : '';

    lines.push(`- ${kindLabel} ${refLabel}${titlePart}${statePart}${urlPart}`);
  }

  return lines.join('\n');
}
