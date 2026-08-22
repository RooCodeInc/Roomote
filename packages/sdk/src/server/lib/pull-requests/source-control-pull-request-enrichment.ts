import { z } from 'zod';
import { createGitHubToken } from '@roomote/auth';
import { getOctokit } from '@roomote/github';
import type { SourceControlProvider } from '@roomote/types';

import { requestSourceControlJson } from './source-control-pull-request-http';
import {
  resolveAdoProviderContext,
  resolveBitbucketProviderContext,
  resolveGiteaProviderContext,
  resolveGitLabProviderContext,
} from './source-control-pull-request-provider-context';
import {
  buildAdoBasicAuthHeader,
  buildApiUrl,
  buildGitLabTokenHeader,
  splitRepositoryFullName,
  type FetchImpl,
  type RepositoryRow,
} from './source-control-pull-request-shared';

/**
 * Per-pull-request enrichment the list payloads cannot carry: the files a
 * PR touched and who reviewed it. Every provider needs one to three extra
 * requests per PR for this, so it runs behind a budget (see
 * pull-request-facts-enrichment.ts) rather than inside the list sync.
 *
 * Field gaps by provider, resolved here so the shape stays uniform:
 * - GitLab's diff listing carries paths but no per-file line counts, so
 *   additions/deletions are null there.
 * - Azure DevOps lists changes per iteration; the latest iteration is the
 *   PR's current file set. Reviewer votes map to approval states.
 * - Bitbucket has no review objects; reviewer participants carry an
 *   `approved` flag and a `changes_requested` state.
 */

type PullRequestReviewState =
  | 'approved'
  | 'changes_requested'
  | 'commented'
  | 'dismissed'
  | 'pending';

export type PullRequestReviewSummary = {
  login: string | null;
  state: PullRequestReviewState;
};

export type PullRequestChangedFile = {
  path: string;
  status: string | null;
  additions: number | null;
  deletions: number | null;
};

export type PullRequestEnrichment = {
  files: PullRequestChangedFile[];
  /** True when the provider listing was cut off at the fetch cap. */
  filesTruncated: boolean;
  reviews: PullRequestReviewSummary[];
};

/** Files fetched per PR before giving up on completeness (3 provider pages). */
const FILE_FETCH_CAP = 300;
const FILE_PAGE_SIZE = 100;
const ADO_API_VERSION = '7.1';

function sumOrNull(values: Array<number | null>): number | null {
  return values.every((value) => value === null)
    ? null
    : values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
}

/** Line totals across the fetched files, null when the provider gives none. */
export function totalPullRequestLineChanges(files: PullRequestChangedFile[]): {
  additions: number | null;
  deletions: number | null;
} {
  return {
    additions: sumOrNull(files.map((file) => file.additions)),
    deletions: sumOrNull(files.map((file) => file.deletions)),
  };
}

// ── GitHub ─────────────────────────────────────────────────────────────

async function readGitHubEnrichment(
  repository: RepositoryRow,
  prNumber: number,
): Promise<PullRequestEnrichment> {
  if (!repository.installationId) {
    throw new Error(
      `GitHub repository ${repository.fullName} is missing an installation id.`,
    );
  }
  const [owner, repo] = splitRepositoryFullName(repository.fullName, 'github');
  const octokit = getOctokit(
    await createGitHubToken({
      type: 'installationId',
      installationId: repository.installationId,
    }),
  );

  const files: PullRequestChangedFile[] = [];
  let filesTruncated = false;

  for (let page = 1; files.length < FILE_FETCH_CAP; page++) {
    const { data } = await octokit.rest.pulls.listFiles({
      owner,
      repo,
      pull_number: prNumber,
      per_page: FILE_PAGE_SIZE,
      page,
    });
    files.push(
      ...data.map((file) => ({
        path: file.filename,
        status: file.status ?? null,
        additions: file.additions ?? null,
        deletions: file.deletions ?? null,
      })),
    );
    if (data.length < FILE_PAGE_SIZE) {
      break;
    }
    if (files.length >= FILE_FETCH_CAP) {
      filesTruncated = true;
    }
  }

  const { data: reviews } = await octokit.rest.pulls.listReviews({
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100,
  });

  return {
    files: files.slice(0, FILE_FETCH_CAP),
    filesTruncated,
    reviews: reviews.flatMap((review) => {
      const state = mapGitHubReviewState(review.state);
      return state ? [{ login: review.user?.login ?? null, state }] : [];
    }),
  };
}

function mapGitHubReviewState(state: string): PullRequestReviewState | null {
  switch (state) {
    case 'APPROVED':
      return 'approved';
    case 'CHANGES_REQUESTED':
      return 'changes_requested';
    case 'COMMENTED':
      return 'commented';
    case 'DISMISSED':
      return 'dismissed';
    case 'PENDING':
      return 'pending';
    default:
      return null;
  }
}

// ── GitLab ─────────────────────────────────────────────────────────────

const gitLabDiffListSchema = z.array(
  z
    .object({
      new_path: z.string().optional(),
      old_path: z.string().optional(),
      new_file: z.boolean().optional(),
      deleted_file: z.boolean().optional(),
      renamed_file: z.boolean().optional(),
    })
    .passthrough(),
);
const gitLabApprovalsSchema = z
  .object({
    approved_by: z
      .array(
        z
          .object({
            user: z.object({ username: z.string().optional() }).passthrough(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

async function readGitLabEnrichment(
  repository: RepositoryRow,
  prNumber: number,
  fetchImpl: FetchImpl,
): Promise<PullRequestEnrichment> {
  const { projectId, token, apiBaseUrl } = await resolveGitLabProviderContext(
    repository,
    'read',
  );
  const tokenHeader = buildGitLabTokenHeader(token);
  const base = `/projects/${encodeURIComponent(projectId)}/merge_requests/${prNumber}`;
  const files: PullRequestChangedFile[] = [];
  let filesTruncated = false;

  for (let page = 1; files.length < FILE_FETCH_CAP; page++) {
    const diffs = await requestSourceControlJson({
      fetchImpl,
      url: buildApiUrl(apiBaseUrl, `${base}/diffs`, {
        per_page: FILE_PAGE_SIZE,
        page,
      }),
      tokenHeader,
      schema: gitLabDiffListSchema,
      acceptedStatuses: [200],
    });
    files.push(
      ...diffs.flatMap((diff) => {
        const path = diff.new_path ?? diff.old_path;
        return path
          ? [
              {
                path,
                status: diff.new_file
                  ? 'added'
                  : diff.deleted_file
                    ? 'removed'
                    : diff.renamed_file
                      ? 'renamed'
                      : 'modified',
                additions: null,
                deletions: null,
              },
            ]
          : [];
      }),
    );
    if (diffs.length < FILE_PAGE_SIZE) {
      break;
    }
    if (files.length >= FILE_FETCH_CAP) {
      filesTruncated = true;
    }
  }

  const approvals = await requestSourceControlJson({
    fetchImpl,
    url: buildApiUrl(apiBaseUrl, `${base}/approvals`, {}),
    tokenHeader,
    schema: gitLabApprovalsSchema,
    acceptedStatuses: [200],
  });

  return {
    files: files.slice(0, FILE_FETCH_CAP),
    filesTruncated,
    reviews: (approvals.approved_by ?? []).map((entry) => ({
      login: entry.user.username ?? null,
      state: 'approved' as const,
    })),
  };
}

// ── Gitea ──────────────────────────────────────────────────────────────

const giteaFileListSchema = z.array(
  z
    .object({
      filename: z.string(),
      status: z.string().optional(),
      additions: z.number().optional(),
      deletions: z.number().optional(),
    })
    .passthrough(),
);
const giteaReviewSummaryListSchema = z.array(
  z
    .object({
      state: z.string().optional(),
      user: z
        .object({ login: z.string().optional() })
        .passthrough()
        .nullable()
        .optional(),
    })
    .passthrough(),
);

async function readGiteaEnrichment(
  repository: RepositoryRow,
  prNumber: number,
  fetchImpl: FetchImpl,
): Promise<PullRequestEnrichment> {
  const { apiBaseUrl, owner, repo, token } = await resolveGiteaProviderContext(
    repository,
    'read',
  );
  const tokenHeader = { name: 'Authorization', value: `token ${token}` };
  const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${prNumber}`;
  const files: PullRequestChangedFile[] = [];
  let filesTruncated = false;

  for (let page = 1; files.length < FILE_FETCH_CAP; page++) {
    const rows = await requestSourceControlJson({
      fetchImpl,
      url: buildApiUrl(apiBaseUrl, `${base}/files`, {
        limit: FILE_PAGE_SIZE,
        page,
      }),
      tokenHeader,
      schema: giteaFileListSchema,
      acceptedStatuses: [200],
    });
    files.push(
      ...rows.map((file) => ({
        path: file.filename,
        status: file.status ?? null,
        additions: file.additions ?? null,
        deletions: file.deletions ?? null,
      })),
    );
    if (rows.length < FILE_PAGE_SIZE) {
      break;
    }
    if (files.length >= FILE_FETCH_CAP) {
      filesTruncated = true;
    }
  }

  const reviews = await requestSourceControlJson({
    fetchImpl,
    url: buildApiUrl(apiBaseUrl, `${base}/reviews`, {}),
    tokenHeader,
    schema: giteaReviewSummaryListSchema,
    acceptedStatuses: [200],
  });

  return {
    files: files.slice(0, FILE_FETCH_CAP),
    filesTruncated,
    reviews: reviews.flatMap((review) => {
      const state = mapGiteaReviewState(review.state ?? '');
      return state ? [{ login: review.user?.login ?? null, state }] : [];
    }),
  };
}

function mapGiteaReviewState(state: string): PullRequestReviewState | null {
  switch (state) {
    case 'APPROVED':
      return 'approved';
    case 'REQUEST_CHANGES':
      return 'changes_requested';
    case 'COMMENT':
      return 'commented';
    case 'PENDING':
      return 'pending';
    default:
      return null;
  }
}

// ── Bitbucket ──────────────────────────────────────────────────────────

const bitbucketDiffstatSchema = z
  .object({
    values: z.array(
      z
        .object({
          status: z.string().optional(),
          lines_added: z.number().optional(),
          lines_removed: z.number().optional(),
          new: z
            .object({ path: z.string().optional() })
            .passthrough()
            .nullable()
            .optional(),
          old: z
            .object({ path: z.string().optional() })
            .passthrough()
            .nullable()
            .optional(),
        })
        .passthrough(),
    ),
    next: z.string().optional(),
  })
  .passthrough();
const bitbucketParticipantsSchema = z
  .object({
    participants: z
      .array(
        z
          .object({
            role: z.string().optional(),
            approved: z.boolean().optional(),
            state: z.string().nullable().optional(),
            user: z
              .object({
                nickname: z.string().optional(),
                display_name: z.string().optional(),
              })
              .passthrough()
              .nullable()
              .optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

async function readBitbucketEnrichment(
  repository: RepositoryRow,
  prNumber: number,
  fetchImpl: FetchImpl,
): Promise<PullRequestEnrichment> {
  const { apiBaseUrl, authHeader, workspace, repo } =
    await resolveBitbucketProviderContext(repository, 'read');
  const tokenHeader = { name: 'Authorization', value: authHeader };
  const base = `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repo)}/pullrequests/${prNumber}`;
  const files: PullRequestChangedFile[] = [];
  let filesTruncated = false;
  let url: string | null = buildApiUrl(apiBaseUrl, `${base}/diffstat`, {
    pagelen: FILE_PAGE_SIZE,
  });

  while (url && files.length < FILE_FETCH_CAP) {
    const page: z.infer<typeof bitbucketDiffstatSchema> =
      await requestSourceControlJson({
        fetchImpl,
        url,
        tokenHeader,
        schema: bitbucketDiffstatSchema,
        acceptedStatuses: [200],
      });
    files.push(
      ...page.values.flatMap((entry) => {
        const path = entry.new?.path ?? entry.old?.path;
        return path
          ? [
              {
                path,
                status: entry.status ?? null,
                additions: entry.lines_added ?? null,
                deletions: entry.lines_removed ?? null,
              },
            ]
          : [];
      }),
    );
    url = page.next ?? null;
    if (url && files.length >= FILE_FETCH_CAP) {
      filesTruncated = true;
    }
  }

  const details = await requestSourceControlJson({
    fetchImpl,
    url: buildApiUrl(apiBaseUrl, base, {}),
    tokenHeader,
    schema: bitbucketParticipantsSchema,
    acceptedStatuses: [200],
  });

  return {
    files: files.slice(0, FILE_FETCH_CAP),
    filesTruncated,
    reviews: (details.participants ?? []).flatMap((participant) => {
      if (participant.role !== 'REVIEWER') {
        return [];
      }
      const state: PullRequestReviewState | null = participant.approved
        ? 'approved'
        : participant.state === 'changes_requested'
          ? 'changes_requested'
          : null;
      return state
        ? [
            {
              login:
                participant.user?.nickname ??
                participant.user?.display_name ??
                null,
              state,
            },
          ]
        : [];
    }),
  };
}

// ── Azure DevOps ───────────────────────────────────────────────────────

const adoIterationsSchema = z
  .object({ value: z.array(z.object({ id: z.number() }).passthrough()) })
  .passthrough();
const adoIterationChangesSchema = z
  .object({
    changeEntries: z
      .array(
        z
          .object({
            changeType: z.string().optional(),
            item: z
              .object({ path: z.string().optional() })
              .passthrough()
              .optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();
const adoReviewersSchema = z
  .object({
    reviewers: z
      .array(
        z
          .object({
            displayName: z.string().optional(),
            uniqueName: z.string().optional(),
            vote: z.number().optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

async function readAdoEnrichment(
  repository: RepositoryRow,
  prNumber: number,
  fetchImpl: FetchImpl,
): Promise<PullRequestEnrichment> {
  const { organizationApiBaseUrl, repositoryPullRequestsPath, token } =
    await resolveAdoProviderContext(repository, 'read');
  const tokenHeader = {
    name: 'Authorization',
    value: buildAdoBasicAuthHeader(token),
  };
  const base = `${repositoryPullRequestsPath}/${prNumber}`;

  const iterations = await requestSourceControlJson({
    fetchImpl,
    url: buildApiUrl(organizationApiBaseUrl, `${base}/iterations`, {
      'api-version': ADO_API_VERSION,
    }),
    tokenHeader,
    schema: adoIterationsSchema,
    acceptedStatuses: [200],
  });
  const latest = iterations.value.reduce<number | null>(
    (max, iteration) =>
      max === null || iteration.id > max ? iteration.id : max,
    null,
  );

  let files: PullRequestChangedFile[] = [];
  let filesTruncated = false;

  if (latest !== null) {
    const changes = await requestSourceControlJson({
      fetchImpl,
      url: buildApiUrl(
        organizationApiBaseUrl,
        `${base}/iterations/${latest}/changes`,
        { 'api-version': ADO_API_VERSION, $top: FILE_FETCH_CAP },
      ),
      tokenHeader,
      schema: adoIterationChangesSchema,
      acceptedStatuses: [200],
    });
    const entries = changes.changeEntries ?? [];
    files = entries.flatMap((entry) =>
      entry.item?.path
        ? [
            {
              path: entry.item.path.replace(/^\//, ''),
              status: entry.changeType ?? null,
              additions: null,
              deletions: null,
            },
          ]
        : [],
    );
    filesTruncated = entries.length >= FILE_FETCH_CAP;
  }

  const details = await requestSourceControlJson({
    fetchImpl,
    url: buildApiUrl(organizationApiBaseUrl, base, {
      'api-version': ADO_API_VERSION,
    }),
    tokenHeader,
    schema: adoReviewersSchema,
    acceptedStatuses: [200],
  });

  return {
    files,
    filesTruncated,
    reviews: (details.reviewers ?? []).flatMap((reviewer) => {
      // Votes: 10 approved, 5 approved with suggestions, 0 no vote,
      // -5 waiting for author, -10 rejected.
      const vote = reviewer.vote ?? 0;
      const state: PullRequestReviewState | null =
        vote >= 5 ? 'approved' : vote < 0 ? 'changes_requested' : null;
      return state
        ? [
            {
              login: reviewer.uniqueName ?? reviewer.displayName ?? null,
              state,
            },
          ]
        : [];
    }),
  };
}

// ── Dispatch ───────────────────────────────────────────────────────────

export async function readSourceControlPullRequestEnrichment({
  repository,
  provider,
  prNumber,
  fetchImpl = fetch,
}: {
  repository: RepositoryRow;
  provider: SourceControlProvider;
  prNumber: number;
  fetchImpl?: FetchImpl;
}): Promise<PullRequestEnrichment> {
  switch (provider) {
    case 'github':
      return readGitHubEnrichment(repository, prNumber);
    case 'gitlab':
      return readGitLabEnrichment(repository, prNumber, fetchImpl);
    case 'gitea':
      return readGiteaEnrichment(repository, prNumber, fetchImpl);
    case 'bitbucket':
      return readBitbucketEnrichment(repository, prNumber, fetchImpl);
    case 'ado':
      return readAdoEnrichment(repository, prNumber, fetchImpl);
    default:
      throw new Error(
        `Pull request enrichment is not supported for provider ${String(provider)}.`,
      );
  }
}
