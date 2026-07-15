import { z } from 'zod';
import {
  buildAdoBasicAuthHeader,
  buildApiUrl,
  buildGitLabTokenHeader,
  type FetchImpl,
} from './source-control-pull-request-shared';
import { requestSourceControlJson } from './source-control-pull-request-http';

/**
 * Branch-identity open-PR lookup used by create-or-update only.
 *
 * Distinct from the normalized open/merged list surface in
 * `source-control-pull-request-reads.ts`: these helpers return raw provider
 * rows, stop early once a create/update can decide (1 match with a target, 2
 * without for ambiguity), and never produce summary/warnings payloads.
 */

const ADO_API_VERSION = '7.1';
const GITEA_PULLS_PAGE_SIZE = 50;
const GITEA_PULLS_MAX_PAGES = 40;

export const gitLabMergeRequestSchema = z.object({
  iid: z.number().int(),
  title: z.string(),
  web_url: z.string().url().optional(),
  target_branch: z.string().optional(),
  draft: z.boolean().optional(),
  work_in_progress: z.boolean().optional(),
});
const gitLabMergeRequestListSchema = z.array(gitLabMergeRequestSchema);

export const giteaPullRequestSchema = z
  .object({
    number: z.number().int().optional(),
    index: z.number().int().optional(),
    title: z.string().optional(),
    html_url: z.string().url().optional(),
    draft: z.boolean().optional(),
    head: z.object({ ref: z.string().optional() }).optional(),
    base: z.object({ ref: z.string().optional() }).optional(),
  })
  .passthrough();
const giteaPullRequestListSchema = z.array(giteaPullRequestSchema);

export const bitbucketPullRequestSchema = z
  .object({
    id: z.number().int(),
    title: z.string().optional(),
    description: z.string().nullable().optional(),
    draft: z.boolean().optional(),
    links: z
      .object({
        html: z.object({ href: z.string().url().optional() }).optional(),
      })
      .optional(),
    source: z
      .object({
        branch: z.object({ name: z.string().optional() }).optional(),
      })
      .optional(),
    destination: z
      .object({
        branch: z.object({ name: z.string().optional() }).optional(),
      })
      .optional(),
  })
  .passthrough();
const bitbucketPullRequestListSchema = z.object({
  values: z.array(bitbucketPullRequestSchema),
  next: z.string().url().optional().nullable(),
});

export const adoPullRequestSchema = z
  .object({
    pullRequestId: z.number().int(),
    title: z.string(),
    isDraft: z.boolean().optional(),
    targetRefName: z.string().optional(),
  })
  .passthrough();
const adoPullRequestListSchema = z.object({
  value: z.array(adoPullRequestSchema),
});

export type BranchLookupInput = {
  sourceBranch: string;
  targetBranch?: string;
};

export function normalizeAdoBranchRef(branch: string): string {
  return branch.startsWith('refs/heads/') ? branch : `refs/heads/${branch}`;
}

export function stripAdoBranchRef(ref: string | undefined): string | undefined {
  return ref?.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
}

export async function findOpenGitLabMergeRequestsByBranch({
  apiBaseUrl,
  projectId,
  input,
  token,
  fetchImpl,
}: {
  apiBaseUrl: string;
  projectId: string;
  input: BranchLookupInput;
  token: string;
  fetchImpl: FetchImpl;
}) {
  return requestSourceControlJson({
    fetchImpl,
    url: buildApiUrl(
      apiBaseUrl,
      `/projects/${encodeURIComponent(projectId)}/merge_requests`,
      {
        state: 'opened',
        source_branch: input.sourceBranch,
        ...(input.targetBranch ? { target_branch: input.targetBranch } : {}),
        per_page: 2,
      },
    ),
    tokenHeader: buildGitLabTokenHeader(token),
    schema: gitLabMergeRequestListSchema,
    acceptedStatuses: [200, 201],
  });
}

/**
 * Gitea's pulls listing has no head/base filter, so matching happens
 * client-side and must walk pages: stopping at the first page could
 * falsely conclude no pull request exists for the source branch. The walk
 * ends as soon as the caller has what it needs — one match when the target
 * branch pins a unique head+base pair, two when an omitted targetBranch
 * only needs enough to prove ambiguity.
 */
export async function findOpenGiteaPullRequestsByBranch({
  apiBaseUrl,
  owner,
  repo,
  input,
  token,
  fetchImpl,
}: {
  apiBaseUrl: string;
  owner: string;
  repo: string;
  input: BranchLookupInput;
  token: string;
  fetchImpl: FetchImpl;
}) {
  const matches: z.infer<typeof giteaPullRequestSchema>[] = [];
  const enoughMatches = input.targetBranch ? 1 : 2;

  for (let page = 1; page <= GITEA_PULLS_MAX_PAGES; page++) {
    const pullRequests = await requestSourceControlJson({
      fetchImpl,
      url: buildApiUrl(
        apiBaseUrl,
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`,
        { state: 'open', limit: GITEA_PULLS_PAGE_SIZE, page },
      ),
      tokenHeader: { name: 'Authorization', value: `token ${token}` },
      schema: giteaPullRequestListSchema,
      acceptedStatuses: [200, 201],
    });

    matches.push(
      ...pullRequests.filter(
        (pullRequest) =>
          pullRequest.head?.ref === input.sourceBranch &&
          (!input.targetBranch || pullRequest.base?.ref === input.targetBranch),
      ),
    );

    if (
      matches.length >= enoughMatches ||
      pullRequests.length < GITEA_PULLS_PAGE_SIZE
    ) {
      break;
    }
  }

  return matches;
}

export async function findOpenBitbucketPullRequestsByBranch({
  apiBaseUrl,
  workspace,
  repo,
  input,
  tokenHeader,
  fetchImpl,
}: {
  apiBaseUrl: string;
  workspace: string;
  repo: string;
  input: BranchLookupInput;
  tokenHeader: { name: string; value: string };
  fetchImpl: FetchImpl;
}) {
  const matches: z.infer<typeof bitbucketPullRequestSchema>[] = [];
  const enoughMatches = input.targetBranch ? 1 : 2;
  let nextUrl: string | null = buildApiUrl(
    apiBaseUrl,
    `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(
      repo,
    )}/pullrequests`,
    { state: 'OPEN', pagelen: 50 },
  );

  while (nextUrl && matches.length < enoughMatches) {
    const page: z.infer<typeof bitbucketPullRequestListSchema> =
      await requestSourceControlJson({
        fetchImpl,
        url: nextUrl,
        tokenHeader,
        schema: bitbucketPullRequestListSchema,
        acceptedStatuses: [200, 201],
      });

    matches.push(
      ...page.values.filter(
        (pullRequest: z.infer<typeof bitbucketPullRequestSchema>) =>
          pullRequest.source?.branch?.name === input.sourceBranch &&
          (!input.targetBranch ||
            pullRequest.destination?.branch?.name === input.targetBranch),
      ),
    );

    nextUrl = page.next ?? null;
  }

  return matches;
}

export async function findOpenAdoPullRequestsByBranch({
  organizationApiBaseUrl,
  repositoryPullRequestsPath,
  input,
  token,
  fetchImpl,
}: {
  organizationApiBaseUrl: string;
  repositoryPullRequestsPath: string;
  input: BranchLookupInput;
  token: string;
  fetchImpl: FetchImpl;
}) {
  const result = await requestSourceControlJson({
    fetchImpl,
    url: buildApiUrl(organizationApiBaseUrl, repositoryPullRequestsPath, {
      'api-version': ADO_API_VERSION,
      'searchCriteria.status': 'active',
      'searchCriteria.sourceRefName': normalizeAdoBranchRef(input.sourceBranch),
      ...(input.targetBranch
        ? {
            'searchCriteria.targetRefName': normalizeAdoBranchRef(
              input.targetBranch,
            ),
          }
        : {}),
      $top: 2,
    }),
    tokenHeader: {
      name: 'Authorization',
      value: buildAdoBasicAuthHeader(token),
    },
    schema: adoPullRequestListSchema,
    acceptedStatuses: [200, 201],
  });

  return result.value;
}
