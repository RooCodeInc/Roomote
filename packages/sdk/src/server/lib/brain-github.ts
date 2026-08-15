import {
  and,
  asc,
  db,
  eq,
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

export type BrainGithubPage = {
  slug: string;
  title: string;
  content: string;
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
  since: Date | null;
  limit: number;
}): Promise<{ pages: BrainGithubPage[]; nextSince: Date | null }> {
  let repositoriesToScan: EligibleRepository[];

  try {
    repositoriesToScan = await listEligibleRepositories();
  } catch (error) {
    console.warn(
      `[brainGithub] failed to list repositories: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return { pages: [], nextSince: input.since };
  }

  const pages: BrainGithubPage[] = [];
  const commentBudget = { remaining: MAX_COMMENT_FETCHES_PER_PASS };
  // Default first-pass window when no watermark exists yet; the backfill
  // phase walks the deeper history.
  const since = input.since ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  let maxUpdatedAt: Date | null = input.since;

  for (const repository of repositoriesToScan) {
    if (pages.length >= input.limit) {
      break;
    }

    const [owner, repo] = repository.fullName.split('/');

    if (!owner || !repo) {
      continue;
    }

    try {
      const octokit = await getInstallationOctokit({
        installationId: repository.installationId,
      });
      const response = await octokit.rest.issues.listForRepo({
        owner,
        repo,
        state: 'all',
        since: since.toISOString(),
        sort: 'updated',
        direction: 'asc',
        per_page: Math.min(100, input.limit - pages.length),
      });

      const issues = (response.data as GithubIssue[]).filter(
        (issue) => !issue.pull_request,
      );

      pages.push(
        ...(await pagesForIssues({
          octokit,
          fullName: repository.fullName,
          issues,
          commentBudget,
        })),
      );

      for (const issue of issues) {
        const updatedAt = issue.updated_at ? new Date(issue.updated_at) : null;

        if (updatedAt && (!maxUpdatedAt || updatedAt > maxUpdatedAt)) {
          maxUpdatedAt = updatedAt;
        }
      }
    } catch (error) {
      console.warn(
        `[brainGithub] issue sync failed for ${repository.fullName}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return { pages, nextSince: maxUpdatedAt };
}

type BackfillCursor = { repositoryIndex: number; page: number };

function parseBackfillCursor(cursor: string | null): BackfillCursor {
  if (!cursor) {
    return { repositoryIndex: 0, page: 1 };
  }

  try {
    const parsed = JSON.parse(cursor) as Partial<BackfillCursor>;

    return {
      repositoryIndex:
        typeof parsed.repositoryIndex === 'number' ? parsed.repositoryIndex : 0,
      page:
        typeof parsed.page === 'number' && parsed.page > 0 ? parsed.page : 1,
    };
  } catch {
    return { repositoryIndex: 0, page: 1 };
  }
}

/**
 * One bounded deep-backfill step: a single page of one repository's full
 * issue history, oldest first. The cursor walks pages within a repository,
 * then advances to the next repository, and reports done after the last one.
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
    return { pages: [], nextCursor: null, done: true };
  }

  if (cursor.repositoryIndex >= repositoriesToScan.length) {
    return { pages: [], nextCursor: null, done: true };
  }

  const repository = repositoriesToScan[cursor.repositoryIndex]!;
  const [owner, repo] = repository.fullName.split('/');

  const advance = (): string =>
    JSON.stringify({
      repositoryIndex: cursor.repositoryIndex + 1,
      page: 1,
    } satisfies BackfillCursor);

  if (!owner || !repo) {
    return { pages: [], nextCursor: advance(), done: false };
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
      page: cursor.page,
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
    const isLastRepository =
      cursor.repositoryIndex >= repositoriesToScan.length - 1;

    if (repositoryExhausted && isLastRepository) {
      return { pages, nextCursor: null, done: true };
    }

    return {
      pages,
      nextCursor: repositoryExhausted
        ? advance()
        : JSON.stringify({
            repositoryIndex: cursor.repositoryIndex,
            page: cursor.page + 1,
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
