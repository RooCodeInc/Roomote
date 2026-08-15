import {
  and,
  asc,
  db,
  eq,
  getBrainSyncState,
  githubInstallations,
  isNotNull,
  isNull,
  repositories,
} from '@roomote/db/server';
import { getInstallationOctokit } from '@roomote/github';

/**
 * GitHub issues as Brain memory: the discussion around bugs, features, and
 * decisions that the merged-PR facts mirror does not carry. Reads run with
 * the deployment's own GitHub App installation, so visibility matches what
 * Roomote can already see in the repositories an admin connected.
 *
 * Every GitHub failure is swallowed into a no-progress result: the Brain
 * collector engine treats '429'/'rate_limit' in a thrown message as
 * brain-side backpressure, so an upstream GitHub rate limit must never
 * escape from here and abort the whole collector pass.
 */

const ISSUE_BODY_CHAR_CAP = 4000;
const COMMENT_BODY_CHAR_CAP = 600;
const MAX_COMMENTS_PER_ISSUE = 20;
/** Bounds extra API calls: only this many issues per pass get their comments. */
const MAX_COMMENT_FETCHES_PER_PASS = 30;
const BACKFILL_PER_PAGE = 50;
const GITHUB_REPLAY_OVERLAP_MS = 1000;

export type BrainGithubPage = {
  slug: string;
  title: string;
  content: string;
};

export type BrainGithubCollectionResult = {
  pages: BrainGithubPage[];
  nextSince: null;
  stateUpdates: Array<{
    collectorId: string;
    watermark: Date;
    cursor?: string | null;
  }>;
};

type IncrementalCursor = {
  boundary: string;
  seen: Array<[number, string]>;
};

type EligibleRepository = {
  fullName: string;
  installationId: number;
};

type GithubIssue = {
  number: number;
  title: string;
  body?: string | null;
  state?: string;
  html_url?: string;
  comments?: number;
  created_at?: string;
  updated_at?: string;
  closed_at?: string | null;
  user?: { login?: string } | null;
  labels?: Array<string | { name?: string }>;
  pull_request?: unknown;
};

function parseIncrementalCursor(
  cursor: string | null,
): IncrementalCursor | null {
  if (!cursor) {
    return null;
  }

  try {
    const parsed = JSON.parse(cursor) as Partial<IncrementalCursor>;
    const boundary =
      typeof parsed.boundary === 'string' ? new Date(parsed.boundary) : null;

    if (
      !boundary ||
      Number.isNaN(boundary.getTime()) ||
      !Array.isArray(parsed.seen)
    ) {
      return null;
    }

    return {
      boundary: boundary.toISOString(),
      seen: parsed.seen.filter(
        (entry): entry is [number, string] =>
          Array.isArray(entry) &&
          typeof entry[0] === 'number' &&
          Number.isInteger(entry[0]) &&
          entry[0] > 0 &&
          typeof entry[1] === 'string',
      ),
    };
  } catch {
    return null;
  }
}

/** Fields visible without another API call that change the rendered page. */
function issueRevision(issue: GithubIssue): string {
  return JSON.stringify([
    issue.updated_at,
    issue.title,
    issue.body,
    issue.state,
    issue.comments,
    issue.closed_at,
    issue.user?.login,
    labelNames(issue),
  ]);
}

/**
 * Active GitHub repositories whose installation is present and not
 * suspended, in a stable order so backfill cursors stay meaningful.
 */
async function listEligibleRepositories(): Promise<EligibleRepository[]> {
  const rows = await db
    .select({
      fullName: repositories.fullName,
      installationId: githubInstallations.installationId,
    })
    .from(repositories)
    .innerJoin(
      githubInstallations,
      eq(repositories.installationId, githubInstallations.id),
    )
    .where(
      and(
        eq(repositories.isActive, true),
        eq(repositories.sourceControlProvider, 'github'),
        isNotNull(repositories.installationId),
        isNull(githubInstallations.suspendedAt),
      ),
    )
    .orderBy(asc(repositories.fullName));

  return rows.filter((row) => row.fullName.includes('/'));
}

export async function hasBrainGithubSources(): Promise<boolean> {
  try {
    return (await listEligibleRepositories()).length > 0;
  } catch {
    return false;
  }
}

function labelNames(issue: GithubIssue): string[] {
  return (issue.labels ?? [])
    .map((label) => (typeof label === 'string' ? label : label?.name))
    .filter((name): name is string => Boolean(name));
}

export function buildGithubIssuePage(input: {
  fullName: string;
  issue: GithubIssue;
  comments: Array<{ author: string | null; body: string; createdAt: string }>;
}): BrainGithubPage | null {
  const { fullName, issue } = input;

  if (typeof issue.number !== 'number' || !issue.title) {
    return null;
  }

  const labels = labelNames(issue);
  const body = (issue.body ?? '').trim();
  const commentLines = input.comments.flatMap((comment) => {
    const text = comment.body.trim();

    if (text.length === 0) {
      return [];
    }

    return [
      `**${comment.author ?? 'unknown'}** (${comment.createdAt}):`,
      text.slice(0, COMMENT_BODY_CHAR_CAP),
      '',
    ];
  });

  const content = [
    '---',
    `repository: ${fullName}`,
    `issue_number: ${issue.number}`,
    `state: ${issue.state ?? 'unknown'}`,
    ...(issue.user?.login ? [`author: ${issue.user.login}`] : []),
    ...(labels.length > 0 ? [`labels: ${labels.join(', ')}`] : []),
    ...(issue.created_at ? [`created_at: ${issue.created_at}`] : []),
    ...(issue.updated_at ? [`updated_at: ${issue.updated_at}`] : []),
    ...(issue.closed_at ? [`closed_at: ${issue.closed_at}`] : []),
    'provenance: roomote-github-issues',
    '---',
    '',
    `# ${fullName}#${issue.number}: ${issue.title}`,
    '',
    ...(body.length > 0 ? [body.slice(0, ISSUE_BODY_CHAR_CAP), ''] : []),
    ...(commentLines.length > 0 ? ['## Discussion', '', ...commentLines] : []),
    ...(issue.html_url ? [issue.html_url] : []),
  ].join('\n');

  return {
    slug: `github/${fullName}/issues/${issue.number}`,
    title: `${fullName}#${issue.number}: ${issue.title}`,
    content,
  };
}

async function fetchIssueComments(
  octokit: Awaited<ReturnType<typeof getInstallationOctokit>>,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<Array<{ author: string | null; body: string; createdAt: string }>> {
  const response = await octokit.rest.issues.listComments({
    owner,
    repo,
    issue_number: issueNumber,
    per_page: MAX_COMMENTS_PER_ISSUE,
  });

  return response.data.map((comment) => ({
    author: comment.user?.login ?? null,
    body: comment.body ?? '',
    createdAt: comment.created_at,
  }));
}

async function pagesForIssues(input: {
  octokit: Awaited<ReturnType<typeof getInstallationOctokit>>;
  fullName: string;
  issues: GithubIssue[];
  commentBudget: { remaining: number };
}): Promise<BrainGithubPage[]> {
  const [owner, repo] = input.fullName.split('/');
  const pages: BrainGithubPage[] = [];

  for (const issue of input.issues) {
    let comments: Array<{
      author: string | null;
      body: string;
      createdAt: string;
    }> = [];

    if (
      owner &&
      repo &&
      (issue.comments ?? 0) > 0 &&
      input.commentBudget.remaining > 0
    ) {
      input.commentBudget.remaining -= 1;

      try {
        comments = await fetchIssueComments(
          input.octokit,
          owner,
          repo,
          issue.number,
        );
      } catch {
        // A comment fetch failure must not drop the issue itself.
        comments = [];
      }
    }

    const page = buildGithubIssuePage({
      fullName: input.fullName,
      issue,
      comments,
    });

    if (page) {
      pages.push(page);
    }
  }

  return pages;
}

/**
 * Incremental pass: issues updated since the watermark, oldest first, across
 * every eligible repository until the page budget is spent.
 */
export async function collectBrainGithubIssues(input: {
  now: Date;
  limit: number;
}): Promise<BrainGithubCollectionResult> {
  let repositoriesToScan: EligibleRepository[];

  try {
    repositoriesToScan = await listEligibleRepositories();
  } catch (error) {
    console.warn(
      `[brainGithub] failed to list repositories: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return { pages: [], nextSince: null, stateUpdates: [] };
  }

  const pages: BrainGithubPage[] = [];
  const stateUpdates: BrainGithubCollectionResult['stateUpdates'] = [];
  const commentBudget = { remaining: MAX_COMMENT_FETCHES_PER_PASS };
  const repositoriesWithState = await Promise.all(
    repositoriesToScan.map(async (repository) => {
      const stateId = `github-issues:${repository.fullName}`;

      return {
        ...repository,
        stateId,
        state: await getBrainSyncState(db, stateId),
      };
    }),
  );

  repositoriesWithState.sort(
    (a, b) =>
      (a.state?.watermark?.getTime() ?? 0) -
        (b.state?.watermark?.getTime() ?? 0) ||
      a.fullName.localeCompare(b.fullName),
  );

  for (const repository of repositoriesWithState) {
    if (pages.length >= input.limit) {
      break;
    }

    const [owner, repo] = repository.fullName.split('/');

    if (!owner || !repo) {
      continue;
    }

    try {
      // New repositories start with a short recent window; the separate
      // durable backfill walks their older history.
      const cursor = parseIncrementalCursor(
        repository.state?.backfillCursor ?? null,
      );
      const since =
        repository.state?.watermark ??
        new Date(input.now.getTime() - 30 * 24 * 60 * 60 * 1000);
      const boundary = cursor ? new Date(cursor.boundary) : since;
      let progressBoundary = boundary;
      let seenAtBoundary = new Map(cursor?.seen ?? []);
      let apiPage = 1;
      let caughtUp = false;
      const octokit = await getInstallationOctokit({
        installationId: repository.installationId,
      });

      while (pages.length < input.limit) {
        const replayingBoundary = cursor !== null || progressBoundary > since;
        const querySince = replayingBoundary
          ? new Date(progressBoundary.getTime() - 1)
          : progressBoundary;
        const response = await octokit.rest.issues.listForRepo({
          owner,
          repo,
          state: 'all',
          since: querySince.toISOString(),
          sort: 'updated',
          direction: 'asc',
          per_page: 100,
          page: apiPage,
        });
        const rawIssues = response.data as GithubIssue[];
        const processed: GithubIssue[] = [];
        const issues: GithubIssue[] = [];
        let hitBudget = false;

        for (const issue of rawIssues) {
          const updatedAt = issue.updated_at
            ? new Date(issue.updated_at)
            : progressBoundary;
          const updatedAtMs = Number.isNaN(updatedAt.getTime())
            ? progressBoundary.getTime()
            : updatedAt.getTime();

          if (
            updatedAtMs < progressBoundary.getTime() ||
            (updatedAtMs === progressBoundary.getTime() &&
              seenAtBoundary.get(issue.number) === issueRevision(issue))
          ) {
            continue;
          }

          if (
            !issue.pull_request &&
            pages.length + issues.length >= input.limit
          ) {
            hitBudget = true;
            break;
          }

          processed.push(issue);

          if (!issue.pull_request) {
            issues.push(issue);
          }
        }

        pages.push(
          ...(await pagesForIssues({
            octokit,
            fullName: repository.fullName,
            issues,
            commentBudget,
          })),
        );

        for (const issue of processed) {
          const updatedAt = issue.updated_at
            ? new Date(issue.updated_at)
            : progressBoundary;
          const safeUpdatedAt = Number.isNaN(updatedAt.getTime())
            ? progressBoundary
            : updatedAt;

          if (safeUpdatedAt > progressBoundary) {
            progressBoundary = safeUpdatedAt;
            seenAtBoundary = new Map();
          }

          if (safeUpdatedAt.getTime() === progressBoundary.getTime()) {
            seenAtBoundary.set(issue.number, issueRevision(issue));
          }
        }

        if (hitBudget) {
          break;
        }

        // Any progress changes the keyset. Restart at page one so an item
        // shifted backward by a concurrent update cannot fall behind the
        // local offset. Exhaustion requires a complete scan with no progress.
        if (processed.length > 0) {
          apiPage = 1;
          continue;
        }

        if (rawIssues.length < 100) {
          caughtUp = true;
          break;
        }

        apiPage += 1;
      }

      // Keep the keyset cursor even after a scan catches up. A mutable offset
      // can look exhausted after an unread issue shifted into an earlier page;
      // replaying this boundary next tick makes that issue reachable. The
      // scheduling watermark can still move forward so quiet repositories do
      // not starve active ones.
      stateUpdates.push({
        collectorId: repository.stateId,
        watermark: caughtUp
          ? new Date(input.now.getTime() - GITHUB_REPLAY_OVERLAP_MS)
          : progressBoundary,
        cursor: JSON.stringify({
          boundary: progressBoundary.toISOString(),
          seen: [...seenAtBoundary].sort(([a], [b]) => a - b),
        }),
      });
    } catch (error) {
      console.warn(
        `[brainGithub] issue sync failed for ${repository.fullName}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return { pages, nextSince: null, stateUpdates };
}

type BackfillCursor = {
  completed: string[];
  repository: string | null;
  page: number;
};

function parseBackfillCursor(cursor: string | null): BackfillCursor {
  if (!cursor) {
    return { completed: [], repository: null, page: 1 };
  }

  try {
    const parsed = JSON.parse(cursor) as Partial<BackfillCursor>;

    return {
      completed: Array.isArray(parsed.completed)
        ? parsed.completed.filter(
            (entry): entry is string => typeof entry === 'string',
          )
        : [],
      repository:
        typeof parsed.repository === 'string' ? parsed.repository : null,
      page:
        typeof parsed.page === 'number' && parsed.page > 0 ? parsed.page : 1,
    };
  } catch {
    return { completed: [], repository: null, page: 1 };
  }
}

/**
 * One bounded deep-backfill step: a single page of one repository's full
 * issue history, oldest first. Completed repository identities are retained
 * while the collector stays open, so a repository connected later is found
 * and backfilled without invalidating a positional cursor.
 */
export async function backfillBrainGithubIssuesStep(input: {
  cursor: string | null;
}): Promise<{
  pages: BrainGithubPage[];
  nextCursor: string | null;
  done: boolean;
}> {
  const cursor = parseBackfillCursor(input.cursor);
  let repositoriesToScan: EligibleRepository[];

  try {
    repositoriesToScan = await listEligibleRepositories();
  } catch {
    return { pages: [], nextCursor: input.cursor, done: false };
  }

  if (repositoriesToScan.length === 0) {
    return { pages: [], nextCursor: input.cursor, done: false };
  }

  const completed = new Set(cursor.completed);
  const repository =
    repositoriesToScan.find(
      (candidate) => candidate.fullName === cursor.repository,
    ) ??
    repositoriesToScan.find((candidate) => !completed.has(candidate.fullName));

  if (!repository) {
    const nextCursor = JSON.stringify({
      completed: [...completed].sort(),
      repository: null,
      page: 1,
    } satisfies BackfillCursor);

    return { pages: [], nextCursor, done: false };
  }

  const page = repository.fullName === cursor.repository ? cursor.page : 1;
  const [owner, repo] = repository.fullName.split('/');

  if (!owner || !repo) {
    completed.add(repository.fullName);
    return {
      pages: [],
      nextCursor: JSON.stringify({
        completed: [...completed].sort(),
        repository: null,
        page: 1,
      } satisfies BackfillCursor),
      done: false,
    };
  }

  try {
    const octokit = await getInstallationOctokit({
      installationId: repository.installationId,
    });
    const response = await octokit.rest.issues.listForRepo({
      owner,
      repo,
      state: 'all',
      sort: 'updated',
      direction: 'asc',
      per_page: BACKFILL_PER_PAGE,
      page,
    });

    const rawIssues = response.data as GithubIssue[];
    const issues = rawIssues.filter((issue) => !issue.pull_request);
    const pages = await pagesForIssues({
      octokit,
      fullName: repository.fullName,
      issues,
      commentBudget: { remaining: MAX_COMMENT_FETCHES_PER_PASS },
    });

    // Short page means this repository's history is exhausted.
    const repositoryExhausted = rawIssues.length < BACKFILL_PER_PAGE;
    if (repositoryExhausted) {
      completed.add(repository.fullName);
    }

    return {
      pages,
      nextCursor: repositoryExhausted
        ? JSON.stringify({
            completed: [...completed].sort(),
            repository: null,
            page: 1,
          } satisfies BackfillCursor)
        : JSON.stringify({
            completed: [...completed].sort(),
            repository: repository.fullName,
            page: page + 1,
          } satisfies BackfillCursor),
      done: false,
    };
  } catch (error) {
    console.warn(
      `[brainGithub] issue backfill failed for ${repository.fullName}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );

    // No progress: hold this cursor and retry on the next tick.
    return { pages: [], nextCursor: input.cursor, done: false };
  }
}
