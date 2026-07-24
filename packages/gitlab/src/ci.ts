import { z } from 'zod';

import { requestGitLab, requestGitLabJson, resolveGitLabToken } from './api';

const GITLAB_FAILURE_EVIDENCE_MAX_JOBS = 3;
const GITLAB_FAILURE_EVIDENCE_TRACE_CHARS = 6_000;
const GITLAB_FAILURE_EVIDENCE_TIMEOUT_MS = 5_000;

const gitLabPipelineSchema = z
  .object({
    id: z.number(),
    name: z.string().nullable().optional(),
    ref: z.string(),
    sha: z.string(),
    status: z.string(),
    source: z.string().optional(),
    web_url: z.string(),
  })
  .passthrough();

/**
 * Nested/child pipeline sources that usually re-fire when a parent pipeline
 * fails. One investigation per repository is enough; webhook and Manual Run
 * share this filter.
 */
export const GITLAB_NESTED_PIPELINE_SOURCES = [
  'parent_pipeline',
  'pipeline',
  'ondemand_dast_scan',
  'ondemand_dast_validation',
] as const;

export function isNestedGitLabPipelineSource(
  source: string | null | undefined,
): boolean {
  const normalized = source?.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return (GITLAB_NESTED_PIPELINE_SOURCES as readonly string[]).includes(
    normalized,
  );
}

const gitLabPipelineJobSchema = z
  .object({
    id: z.number(),
    name: z.string(),
    stage: z.string().nullable().optional(),
    status: z.string(),
    failure_reason: z.string().nullable().optional(),
    allow_failure: z.boolean().optional(),
  })
  .passthrough();
const gitLabPipelineJobListSchema = z.array(gitLabPipelineJobSchema);

export type GitLabPipeline = z.infer<typeof gitLabPipelineSchema>;
export type GitLabPipelineJob = z.infer<typeof gitLabPipelineJobSchema>;

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

function formatGitLabPipelineJobEvidence(params: {
  job: GitLabPipelineJob;
  trace: string | null;
  traceTruncated: boolean;
}): string {
  const metadata = [
    `job=${JSON.stringify(params.job.name)}`,
    `id=${params.job.id}`,
    ...(params.job.stage ? [`stage=${JSON.stringify(params.job.stage)}`] : []),
    ...(params.job.failure_reason
      ? [`failure_reason=${JSON.stringify(params.job.failure_reason)}`]
      : []),
  ].join(' ');

  if (!params.trace) {
    return `${metadata}\nLog trace unavailable.`;
  }

  return `${metadata}\n${params.traceTruncated ? '[Earlier log output omitted; showing the tail.]\n' : ''}${params.trace}`;
}

/**
 * Reads the newest pipeline for a branch using the deployment-held GitLab
 * credential. A missing pipeline is a normal null result.
 */
export async function getLatestGitLabPipeline(params: {
  projectId: string;
  ref: string;
  token?: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<GitLabPipeline | null> {
  const token = params.token ?? (await resolveGitLabToken());
  if (!token?.trim()) {
    throw new Error(
      'GitLab OAuth authorization is required to inspect CI pipelines.',
    );
  }

  const response = await requestGitLab(
    {
      apiBaseUrl: params.apiBaseUrl,
      fetchImpl: params.fetchImpl,
      path: `/projects/${encodeURIComponent(params.projectId)}/pipelines/latest`,
      params: { ref: params.ref },
      token,
      signal: AbortSignal.timeout(GITLAB_FAILURE_EVIDENCE_TIMEOUT_MS),
    },
    [200, 403, 404],
  );

  if (response.status !== 200) {
    return null;
  }

  return gitLabPipelineSchema.parse(await response.json());
}

/**
 * Fetches a bounded, prompt-ready snapshot of failed job metadata and log
 * tails. Webhook callers can pass the jobs already present in the payload;
 * manual runs omit them and read failed jobs from the pipeline API.
 */
export async function getGitLabPipelineFailureEvidence(params: {
  projectId: string;
  pipelineId: number;
  jobs?: GitLabPipelineJob[];
  token?: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<string | null> {
  const token = params.token ?? (await resolveGitLabToken());
  if (!token?.trim()) {
    throw new Error(
      'GitLab OAuth authorization is required to inspect CI job logs.',
    );
  }

  const jobs =
    params.jobs ??
    (
      await requestGitLabJson({
        apiBaseUrl: params.apiBaseUrl,
        fetchImpl: params.fetchImpl,
        path: `/projects/${encodeURIComponent(params.projectId)}/pipelines/${params.pipelineId}/jobs`,
        params: {
          scope: 'failed',
          include_retried: false,
          per_page: GITLAB_FAILURE_EVIDENCE_MAX_JOBS,
        },
        token,
        signal: AbortSignal.timeout(GITLAB_FAILURE_EVIDENCE_TIMEOUT_MS),
        schema: gitLabPipelineJobListSchema,
      })
    ).data;

  const failedJobs = jobs
    .filter((job) => job.status.toLowerCase() === 'failed')
    .sort((left, right) => {
      if (Boolean(left.allow_failure) !== Boolean(right.allow_failure)) {
        return left.allow_failure ? 1 : -1;
      }
      return right.id - left.id;
    })
    .slice(0, GITLAB_FAILURE_EVIDENCE_MAX_JOBS);

  if (failedJobs.length === 0) {
    return null;
  }

  const evidence = await Promise.all(
    failedJobs.map(async (job) => {
      try {
        const response = await requestGitLab(
          {
            apiBaseUrl: params.apiBaseUrl,
            fetchImpl: params.fetchImpl,
            path: `/projects/${encodeURIComponent(params.projectId)}/jobs/${job.id}/trace`,
            token,
            accept: 'text/plain',
            signal: AbortSignal.timeout(GITLAB_FAILURE_EVIDENCE_TIMEOUT_MS),
          },
          [200, 404],
        );

        const trace =
          response.status === 200
            ? await readResponseTextTail(
                response,
                GITLAB_FAILURE_EVIDENCE_TRACE_CHARS,
              )
            : { text: '', truncated: false };

        return formatGitLabPipelineJobEvidence({
          job,
          trace: trace.text.trim() || null,
          traceTruncated: trace.truncated,
        });
      } catch {
        return formatGitLabPipelineJobEvidence({
          job,
          trace: null,
          traceTruncated: false,
        });
      }
    }),
  );

  return evidence.join('\n\n');
}
