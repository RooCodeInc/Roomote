import { z } from 'zod';

import {
  GiteaApiError,
  buildGiteaApiBaseUrl,
  buildGiteaApiUrl,
  normalizeGiteaBaseUrl,
  resolveGiteaBaseUrl,
  resolveGiteaToken,
  splitGiteaRepositoryFullName,
} from './api';

const GITEA_FAILURE_EVIDENCE_TIMEOUT_MS = 15_000;
const GITEA_FAILURE_EVIDENCE_MAX_JOBS = 5;
const GITEA_FAILURE_EVIDENCE_TRACE_CHARS = 12_000;

const giteaActionWorkflowRunSchema = z
  .object({
    id: z.number(),
    url: z.string().optional(),
    html_url: z.string().optional(),
    display_title: z.string().optional(),
    name: z.string().optional(),
    path: z.string().optional(),
    // Gitea ≤1.24 /actions/tasks rows expose workflow file as workflow_id
    // and often put the job name in `name` instead of the workflow path.
    workflow_id: z.string().optional(),
    event: z.string().optional(),
    run_number: z.number().optional(),
    head_sha: z.string().optional(),
    head_branch: z.string().optional(),
    status: z.string().optional(),
    conclusion: z.string().nullable().optional(),
  })
  .passthrough();

const giteaActionWorkflowRunListSchema = z.object({
  workflow_runs: z.array(giteaActionWorkflowRunSchema),
  total_count: z.number().optional(),
});

// Gitea ActionTaskResponse uses Go field Entries; the API tags it as
// `workflow_runs` on current releases, but some payloads/docs use `entries`.
// Accept either and normalize to `tasks`.
const giteaActionTaskListSchema = z
  .object({
    total_count: z.number().optional(),
    workflow_runs: z.array(giteaActionWorkflowRunSchema).optional(),
    entries: z.array(giteaActionWorkflowRunSchema).optional(),
  })
  .transform((value) => ({
    total_count: value.total_count,
    tasks: value.workflow_runs ?? value.entries ?? [],
  }));

const giteaActionWorkflowJobSchema = z
  .object({
    id: z.number(),
    name: z.string().optional(),
    status: z.string().optional(),
    conclusion: z.string().optional(),
    run_id: z.number().optional(),
  })
  .passthrough();

const giteaActionWorkflowJobListSchema = z.object({
  jobs: z.array(giteaActionWorkflowJobSchema),
  total_count: z.number().optional(),
});

export type GiteaActionWorkflowRun = z.infer<
  typeof giteaActionWorkflowRunSchema
>;
export type GiteaActionWorkflowJob = z.infer<
  typeof giteaActionWorkflowJobSchema
>;

const GITEA_ACTION_TASKS_PAGE_LIMIT = 50;
const GITEA_ACTION_JOBS_PAGE_LIMIT = 50;

function stripGiteaGitRef(refName: string | null | undefined): string {
  return (refName ?? '').trim().replace(/^refs\/heads\//, '');
}

function getGiteaWorkflowName(run: GiteaActionWorkflowRun): string {
  const path = (run.path ?? '').trim();
  if (path) {
    // path is often "ci.yml@refs/heads/main" — keep workflow file only.
    const filePart = path.split('@')[0]?.trim();
    if (filePart) {
      return filePart;
    }
  }
  const workflowId = (run.workflow_id ?? '').trim();
  if (workflowId) {
    return workflowId;
  }
  return (
    (run.display_title ?? '').trim() || (run.name ?? '').trim() || 'workflow'
  );
}

/**
 * Map a Gitea ActionTask (from /actions/tasks) onto the workflow-run shape
 * used by callers. On tasks, conclusion is often absent and status carries
 * terminal outcomes like failure / failed / error / success.
 */
function mapGiteaActionTaskToWorkflowRun(
  task: GiteaActionWorkflowRun,
): GiteaActionWorkflowRun {
  const status = (task.status ?? '').trim() || undefined;
  const conclusion = (task.conclusion ?? '').trim() || status || undefined;
  const htmlUrl = (task.html_url ?? task.url ?? '').trim() || undefined;
  // Prefer workflow path/id over job name — 1.24 tasks set name=job.
  const path =
    (task.path ?? '').trim() ||
    (task.workflow_id ?? '').trim() ||
    (task.name ?? '').trim() ||
    undefined;
  const displayTitle =
    (task.display_title ?? '').trim() || (task.name ?? '').trim() || undefined;

  return {
    ...task,
    status,
    conclusion: conclusion ?? null,
    html_url: htmlUrl,
    url: (task.url ?? htmlUrl ?? '').trim() || undefined,
    path,
    display_title: displayTitle,
  };
}

export function getGiteaActionRunWebUrl(params: {
  repositoryFullName: string;
  run: GiteaActionWorkflowRun;
  baseUrl?: string;
}): string {
  const explicit = (params.run.html_url ?? '').trim();
  if (explicit) {
    return explicit;
  }
  const origin = params.baseUrl
    ? normalizeGiteaBaseUrl(params.baseUrl)
    : undefined;
  if (origin) {
    return `${origin}/${params.repositoryFullName}/actions/runs/${params.run.id}`;
  }
  return `actions/runs/${params.run.id}`;
}

export function getGiteaActionRunConclusion(
  run: GiteaActionWorkflowRun,
): string {
  return (run.conclusion ?? run.status ?? '').trim().toLowerCase();
}

/** True when an Actions conclusion/status means the run or job failed. */
export function isGiteaActionRunFailed(
  conclusionOrStatus: string | null | undefined,
): boolean {
  const value = (conclusionOrStatus ?? '').trim().toLowerCase();
  return value === 'failure' || value === 'failed' || value === 'error';
}

async function resolveGiteaAuthContext(params: {
  token?: string;
  baseUrl?: string;
  apiBaseUrl?: string;
}): Promise<{ token: string; apiBaseUrl: string; baseUrl: string | null }> {
  const giteaToken = params.token ?? (await resolveGiteaToken());
  if (!giteaToken?.trim()) {
    throw new Error(
      'Gitea OAuth connection is required to inspect Actions runs.',
    );
  }

  const resolvedBaseUrl = params.baseUrl ?? (await resolveGiteaBaseUrl());
  if (!resolvedBaseUrl?.trim() && !params.apiBaseUrl?.trim()) {
    throw new Error(
      'GITEA_BASE_URL is required to inspect Gitea Actions runs.',
    );
  }

  return {
    token: giteaToken,
    baseUrl: resolvedBaseUrl,
    apiBaseUrl:
      params.apiBaseUrl ?? buildGiteaApiBaseUrl(resolvedBaseUrl ?? ''),
  };
}

async function readResponseTextTail(
  response: Response,
  maxChars: number,
): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) {
    const text = await response.text();
    return {
      text: text.slice(-maxChars),
      truncated: text.length > maxChars,
    };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let tail = '';
  let totalChars = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    const chunk = decoder.decode(value, { stream: true });
    totalChars += chunk.length;
    tail = `${tail}${chunk}`.slice(-maxChars);
  }

  const finalChunk = decoder.decode();
  totalChars += finalChunk.length;
  tail = `${tail}${finalChunk}`.slice(-maxChars);

  return { text: tail, truncated: totalChars > maxChars };
}

function formatGiteaActionJobEvidence(params: {
  job: GiteaActionWorkflowJob;
  logText: string | null;
  logTruncated: boolean;
}): string {
  const conclusion = (
    params.job.conclusion ??
    params.job.status ??
    'unknown'
  ).trim();
  const metadata = [
    `job=${JSON.stringify(params.job.name ?? 'unknown')}`,
    `id=${params.job.id}`,
    `conclusion=${JSON.stringify(conclusion)}`,
  ].join(' ');

  if (!params.logText) {
    return `${metadata}\nLog trace unavailable.`;
  }

  return `${metadata}\n${
    params.logTruncated
      ? '[Earlier log output omitted; showing the tail.]\n'
      : ''
  }${params.logText}`;
}

/**
 * Newest Actions run for a branch tip. Does not filter by conclusion so
 * callers can detect already-green tips before launching triage.
 *
 * Prefers GitHub-compat GET .../actions/runs (Gitea 1.25+). On 404 falls
 * back to GET .../actions/tasks (Gitea ≤1.24 ActionTaskResponse) and
 * client-filters by head_branch.
 */
export async function getLatestGiteaActionRun(params: {
  repositoryFullName: string;
  branch: string;
  token?: string;
  baseUrl?: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<GiteaActionWorkflowRun | null> {
  const auth = await resolveGiteaAuthContext(params);
  const { owner, repo } = splitGiteaRepositoryFullName(
    params.repositoryFullName,
  );
  const fetchImpl = params.fetchImpl ?? fetch;
  const repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const wantedBranch = stripGiteaGitRef(params.branch);
  const authHeaders = {
    Accept: 'application/json',
    Authorization: `Bearer ${auth.token}`,
  } as const;

  const runsResponse = await fetchImpl(
    buildGiteaApiUrl(auth.apiBaseUrl, `${repoPath}/actions/runs`, {
      branch: params.branch,
      limit: 1,
      page: 1,
    }),
    {
      method: 'GET',
      headers: authHeaders,
      signal: AbortSignal.timeout(GITEA_FAILURE_EVIDENCE_TIMEOUT_MS),
    },
  );

  if ([401, 403].includes(runsResponse.status)) {
    throw new Error(
      `Gitea rejected the Actions API request (status ${runsResponse.status}). Confirm the OAuth grant can read Actions runs and the connection has been re-authorized.`,
    );
  }

  if (runsResponse.status === 200) {
    const { workflow_runs: runs } = giteaActionWorkflowRunListSchema.parse(
      await runsResponse.json(),
    );
    return runs[0] ?? null;
  }

  // Gitea ≤1.24 does not expose /actions/runs listing — fall back to tasks.
  if (runsResponse.status !== 404) {
    throw new GiteaApiError(runsResponse.status, runsResponse.statusText);
  }

  const tasksResponse = await fetchImpl(
    buildGiteaApiUrl(auth.apiBaseUrl, `${repoPath}/actions/tasks`, {
      limit: GITEA_ACTION_TASKS_PAGE_LIMIT,
      page: 1,
    }),
    {
      method: 'GET',
      headers: authHeaders,
      signal: AbortSignal.timeout(GITEA_FAILURE_EVIDENCE_TIMEOUT_MS),
    },
  );

  if ([401, 403].includes(tasksResponse.status)) {
    throw new Error(
      `Gitea rejected the Actions API request (status ${tasksResponse.status}). Confirm the OAuth grant can read Actions runs and the connection has been re-authorized.`,
    );
  }

  if (tasksResponse.status === 404) {
    return null;
  }

  if (tasksResponse.status !== 200) {
    throw new GiteaApiError(tasksResponse.status, tasksResponse.statusText);
  }

  const parsed = giteaActionTaskListSchema.parse(await tasksResponse.json());
  const tasks = parsed.tasks;

  // Tasks are typically newest-first; pick the first matching branch tip.
  const match = tasks.find(
    (task) => stripGiteaGitRef(task.head_branch) === wantedBranch,
  );
  return match ? mapGiteaActionTaskToWorkflowRun(match) : null;
}

export async function getGiteaActionRun(params: {
  repositoryFullName: string;
  runId: number;
  token?: string;
  baseUrl?: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<GiteaActionWorkflowRun | null> {
  const auth = await resolveGiteaAuthContext(params);
  const { owner, repo } = splitGiteaRepositoryFullName(
    params.repositoryFullName,
  );
  const fetchImpl = params.fetchImpl ?? fetch;

  const response = await fetchImpl(
    buildGiteaApiUrl(
      auth.apiBaseUrl,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${params.runId}`,
      {},
    ),
    {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${auth.token}`,
      },
      signal: AbortSignal.timeout(GITEA_FAILURE_EVIDENCE_TIMEOUT_MS),
    },
  );

  if ([401, 403].includes(response.status)) {
    throw new Error(
      `Gitea rejected the Actions API request (status ${response.status}). Confirm the OAuth grant can read Actions runs and the connection has been re-authorized.`,
    );
  }

  if (response.status === 404) {
    return null;
  }

  if (response.status !== 200) {
    throw new GiteaApiError(response.status, response.statusText);
  }

  return giteaActionWorkflowRunSchema.parse(await response.json());
}

/**
 * List jobs for an Actions run. Prefers Gitea 1.25+ nested jobs path; on 404
 * tries flat GET .../actions/jobs filtered by run_id (when exposed). Returns
 * null when jobs cannot be listed so triage can still launch without evidence.
 */
async function listGiteaActionRunJobs(params: {
  apiBaseUrl: string;
  token: string;
  repoPath: string;
  runId: number;
  fetchImpl: typeof fetch;
}): Promise<GiteaActionWorkflowJob[] | null> {
  try {
    const authHeaders = {
      Accept: 'application/json',
      Authorization: `Bearer ${params.token}`,
    } as const;

    const nestedResponse = await params.fetchImpl(
      buildGiteaApiUrl(
        params.apiBaseUrl,
        `${params.repoPath}/actions/runs/${params.runId}/jobs`,
        {
          limit: GITEA_ACTION_JOBS_PAGE_LIMIT,
          page: 1,
        },
      ),
      {
        method: 'GET',
        headers: authHeaders,
        signal: AbortSignal.timeout(GITEA_FAILURE_EVIDENCE_TIMEOUT_MS),
      },
    );

    if ([401, 403].includes(nestedResponse.status)) {
      return null;
    }

    if (nestedResponse.status === 200) {
      const { jobs } = giteaActionWorkflowJobListSchema.parse(
        await nestedResponse.json(),
      );
      return jobs;
    }

    if (nestedResponse.status !== 404) {
      // Evidence is best-effort; do not block Manual Run / webhook launch.
      return null;
    }

    // Nested runs/{id}/jobs is missing on older Gitea; try flat jobs list.
    const flatResponse = await params.fetchImpl(
      buildGiteaApiUrl(params.apiBaseUrl, `${params.repoPath}/actions/jobs`, {
        limit: GITEA_ACTION_JOBS_PAGE_LIMIT,
        page: 1,
      }),
      {
        method: 'GET',
        headers: authHeaders,
        signal: AbortSignal.timeout(GITEA_FAILURE_EVIDENCE_TIMEOUT_MS),
      },
    );

    if (flatResponse.status !== 200) {
      return null;
    }

    const { jobs } = giteaActionWorkflowJobListSchema.parse(
      await flatResponse.json(),
    );
    return jobs.filter((job) => job.run_id === params.runId);
  } catch {
    return null;
  }
}

/**
 * Bounded, prompt-ready snapshot of failed Actions jobs and log tails.
 * Logs use GET .../actions/jobs/{job_id}/logs (available on Gitea 1.24+).
 * Returns null when jobs cannot be listed so Manual Run / webhooks still launch.
 */
export async function getGiteaActionRunFailureEvidence(params: {
  repositoryFullName: string;
  runId: number;
  token?: string;
  baseUrl?: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<string | null> {
  const auth = await resolveGiteaAuthContext(params);
  const { owner, repo } = splitGiteaRepositoryFullName(
    params.repositoryFullName,
  );
  const fetchImpl = params.fetchImpl ?? fetch;
  const repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

  const jobs = await listGiteaActionRunJobs({
    apiBaseUrl: auth.apiBaseUrl,
    token: auth.token,
    repoPath,
    runId: params.runId,
    fetchImpl,
  });

  if (!jobs) {
    return null;
  }

  const failedJobs = jobs
    .filter((job) => isGiteaActionRunFailed(job.conclusion ?? job.status ?? ''))
    .slice(0, GITEA_FAILURE_EVIDENCE_MAX_JOBS);

  if (failedJobs.length === 0) {
    return null;
  }

  const evidence = await Promise.all(
    failedJobs.map(async (job) => {
      try {
        const logResponse = await fetchImpl(
          buildGiteaApiUrl(
            auth.apiBaseUrl,
            `${repoPath}/actions/jobs/${job.id}/logs`,
            {},
          ),
          {
            method: 'GET',
            headers: {
              Accept: 'text/plain, application/octet-stream, */*',
              Authorization: `Bearer ${auth.token}`,
            },
            signal: AbortSignal.timeout(GITEA_FAILURE_EVIDENCE_TIMEOUT_MS),
          },
        );

        if (logResponse.status !== 200) {
          return formatGiteaActionJobEvidence({
            job,
            logText: null,
            logTruncated: false,
          });
        }

        const tail = await readResponseTextTail(
          logResponse,
          GITEA_FAILURE_EVIDENCE_TRACE_CHARS,
        );
        return formatGiteaActionJobEvidence({
          job,
          logText: tail.text.trim() || null,
          logTruncated: tail.truncated,
        });
      } catch {
        return formatGiteaActionJobEvidence({
          job,
          logText: null,
          logTruncated: false,
        });
      }
    }),
  );

  return evidence.join('\n\n');
}

export { getGiteaWorkflowName };
