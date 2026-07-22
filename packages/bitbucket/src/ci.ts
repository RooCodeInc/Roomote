import { z } from 'zod';

import {
  BitbucketApiError,
  buildAuthorizationHeader,
  buildBitbucketApiUrl,
  hostFromBaseUrl,
  resolveAuthIdentity,
  splitBitbucketRepositoryFullName,
} from './api';
import { encodeBitbucketUuid, stripUuidBraces } from './api';

const DEFAULT_BITBUCKET_BASE_URL = 'https://bitbucket.org';
const BITBUCKET_FAILURE_EVIDENCE_MAX_STEPS = 5;
const BITBUCKET_FAILURE_EVIDENCE_TRACE_CHARS = 6_000;
const BITBUCKET_FAILURE_EVIDENCE_TIMEOUT_MS = 5_000;

const bitbucketPipelineSchema = z
  .object({
    uuid: z.string(),
    build_number: z.number().optional(),
    created_on: z.string().optional(),
    completed_on: z.string().nullable().optional(),
    target: z
      .object({
        ref_name: z.string().optional(),
        selector: z
          .object({
            type: z.string().optional(),
            pattern: z.string().optional(),
          })
          .passthrough()
          .nullish(),
        commit: z
          .object({
            hash: z.string().optional(),
          })
          .passthrough()
          .nullish(),
      })
      .passthrough()
      .nullish(),
    state: z
      .object({
        name: z.string().optional(),
        type: z.string().optional(),
        result: z
          .object({
            name: z.string().optional(),
            type: z.string().optional(),
          })
          .passthrough()
          .nullish(),
      })
      .passthrough()
      .nullish(),
    links: z
      .object({
        self: z
          .object({
            href: z.string().optional(),
          })
          .optional(),
        steps: z
          .object({
            href: z.string().optional(),
          })
          .optional(),
      })
      .passthrough()
      .nullish(),
  })
  .passthrough();

const bitbucketPipelineListSchema = z.object({
  values: z.array(bitbucketPipelineSchema),
  next: z.string().nullable().optional(),
});

const bitbucketPipelineStepSchema = z
  .object({
    uuid: z.string().optional(),
    name: z.string().optional(),
    state: z
      .object({
        name: z.string().optional(),
        type: z.string().optional(),
        result: z
          .object({
            name: z.string().optional(),
          })
          .passthrough()
          .nullish(),
      })
      .passthrough()
      .nullish(),
  })
  .passthrough();

const bitbucketPipelineStepListSchema = z.object({
  values: z.array(bitbucketPipelineStepSchema),
  next: z.string().nullable().optional(),
});

export type BitbucketPipeline = z.infer<typeof bitbucketPipelineSchema>;
export type BitbucketPipelineStep = z.infer<typeof bitbucketPipelineStepSchema>;

export function getBitbucketPipelineResultName(
  pipeline: BitbucketPipeline,
): string {
  return (pipeline.state?.result?.name ?? pipeline.state?.name ?? '')
    .trim()
    .toUpperCase();
}

export function getBitbucketPipelineWebUrl(params: {
  repositoryFullName: string;
  pipeline: BitbucketPipeline;
  baseUrl?: string;
}): string {
  const host = hostFromBaseUrl(params.baseUrl ?? DEFAULT_BITBUCKET_BASE_URL);
  const buildNumber = params.pipeline.build_number;
  if (buildNumber !== undefined) {
    return `https://${host}/${params.repositoryFullName}/addon/pipelines/home#!/results/${buildNumber}`;
  }
  return `https://${host}/${params.repositoryFullName}/addon/pipelines/home#!/results/${stripUuidBraces(params.pipeline.uuid)}`;
}

/**
 * Newest pipeline for a branch tip. Does not filter by result so callers can
 * detect already-green tips before launching triage.
 */
export async function getLatestBitbucketPipeline(params: {
  repositoryFullName: string;
  branch: string;
  token?: string;
  username?: string;
  baseUrl?: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<BitbucketPipeline | null> {
  const auth = await resolveAuthIdentity({
    token: params.token,
    username: params.username,
    baseUrl: params.baseUrl,
    apiBaseUrl: params.apiBaseUrl,
    fetchImpl: params.fetchImpl,
  });
  const { workspace, repo } = splitBitbucketRepositoryFullName(
    params.repositoryFullName,
  );

  const response = await (params.fetchImpl ?? fetch)(
    buildBitbucketApiUrl(
      auth.apiBaseUrl,
      `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repo)}/pipelines/`,
      {
        pagelen: 1,
        sort: '-created_on',
        'target.ref_name': params.branch,
      },
    ),
    {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization:
          auth.authScheme === 'bearer'
            ? `Bearer ${auth.token}`
            : buildAuthorizationHeader(auth.username, auth.token),
      },
      signal: AbortSignal.timeout(BITBUCKET_FAILURE_EVIDENCE_TIMEOUT_MS),
    },
  );

  // Bitbucket answers a missing `pipeline` OAuth scope with 401/403. Throw so
  // callers surface a credential/scope problem instead of reading it as "no
  // failed pipeline"; only an unknown repository/pipeline maps to null.
  if ([401, 403].includes(response.status)) {
    throw new Error(
      `Bitbucket rejected the Pipelines API request (status ${response.status}). Confirm the OAuth consumer has the pipeline scope and the connection has been re-authorized.`,
    );
  }

  if (response.status === 404) {
    return null;
  }

  if (response.status !== 200) {
    throw new BitbucketApiError(response.status, response.statusText);
  }

  const { values } = bitbucketPipelineListSchema.parse(await response.json());
  return values[0] ?? null;
}

export async function getBitbucketPipeline(params: {
  repositoryFullName: string;
  pipelineUuid: string;
  token?: string;
  username?: string;
  baseUrl?: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<BitbucketPipeline | null> {
  const auth = await resolveAuthIdentity({
    token: params.token,
    username: params.username,
    baseUrl: params.baseUrl,
    apiBaseUrl: params.apiBaseUrl,
    fetchImpl: params.fetchImpl,
  });
  const { workspace, repo } = splitBitbucketRepositoryFullName(
    params.repositoryFullName,
  );

  const response = await (params.fetchImpl ?? fetch)(
    buildBitbucketApiUrl(
      auth.apiBaseUrl,
      `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repo)}/pipelines/${encodeBitbucketUuid(params.pipelineUuid)}`,
      {},
    ),
    {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization:
          auth.authScheme === 'bearer'
            ? `Bearer ${auth.token}`
            : buildAuthorizationHeader(auth.username, auth.token),
      },
      signal: AbortSignal.timeout(BITBUCKET_FAILURE_EVIDENCE_TIMEOUT_MS),
    },
  );

  // Bitbucket answers a missing `pipeline` OAuth scope with 401/403. Throw so
  // callers surface a credential/scope problem instead of reading it as "no
  // failed pipeline"; only an unknown repository/pipeline maps to null.
  if ([401, 403].includes(response.status)) {
    throw new Error(
      `Bitbucket rejected the Pipelines API request (status ${response.status}). Confirm the OAuth consumer has the pipeline scope and the connection has been re-authorized.`,
    );
  }

  if (response.status === 404) {
    return null;
  }

  if (response.status !== 200) {
    throw new BitbucketApiError(response.status, response.statusText);
  }

  return bitbucketPipelineSchema.parse(await response.json());
}

/**
 * Resolve a pipeline by build number on a branch (status webhook URLs often
 * only include the numeric results id). Scans only the newest 20 pipelines on
 * the branch, so a long-delayed webhook on a busy repository can miss; the
 * webhook handler retries on the default branch and then skips.
 */
export async function getBitbucketPipelineByBuildNumber(params: {
  repositoryFullName: string;
  branch: string;
  buildNumber: number;
  token?: string;
  username?: string;
  baseUrl?: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<BitbucketPipeline | null> {
  const auth = await resolveAuthIdentity({
    token: params.token,
    username: params.username,
    baseUrl: params.baseUrl,
    apiBaseUrl: params.apiBaseUrl,
    fetchImpl: params.fetchImpl,
  });
  const { workspace, repo } = splitBitbucketRepositoryFullName(
    params.repositoryFullName,
  );

  const response = await (params.fetchImpl ?? fetch)(
    buildBitbucketApiUrl(
      auth.apiBaseUrl,
      `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repo)}/pipelines/`,
      {
        pagelen: 20,
        sort: '-created_on',
        'target.ref_name': params.branch,
      },
    ),
    {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization:
          auth.authScheme === 'bearer'
            ? `Bearer ${auth.token}`
            : buildAuthorizationHeader(auth.username, auth.token),
      },
      signal: AbortSignal.timeout(BITBUCKET_FAILURE_EVIDENCE_TIMEOUT_MS),
    },
  );

  // Bitbucket answers a missing `pipeline` OAuth scope with 401/403. Throw so
  // callers surface a credential/scope problem instead of reading it as "no
  // failed pipeline"; only an unknown repository/pipeline maps to null.
  if ([401, 403].includes(response.status)) {
    throw new Error(
      `Bitbucket rejected the Pipelines API request (status ${response.status}). Confirm the OAuth consumer has the pipeline scope and the connection has been re-authorized.`,
    );
  }

  if (response.status === 404) {
    return null;
  }

  if (response.status !== 200) {
    throw new BitbucketApiError(response.status, response.statusText);
  }

  const { values } = bitbucketPipelineListSchema.parse(await response.json());
  return (
    values.find((pipeline) => pipeline.build_number === params.buildNumber) ??
    null
  );
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

function formatBitbucketPipelineStepEvidence(params: {
  step: BitbucketPipelineStep;
  logText: string | null;
  logTruncated: boolean;
}): string {
  const resultName =
    params.step.state?.result?.name ?? params.step.state?.name ?? 'unknown';
  const metadata = [
    `step=${JSON.stringify(params.step.name ?? 'unknown')}`,
    ...(params.step.uuid
      ? [`id=${JSON.stringify(stripUuidBraces(params.step.uuid))}`]
      : []),
    `result=${JSON.stringify(resultName)}`,
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
 * Bounded, prompt-ready snapshot of failed pipeline steps and log tails.
 */
export async function getBitbucketPipelineFailureEvidence(params: {
  repositoryFullName: string;
  pipelineUuid: string;
  token?: string;
  username?: string;
  baseUrl?: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<string | null> {
  const auth = await resolveAuthIdentity({
    token: params.token,
    username: params.username,
    baseUrl: params.baseUrl,
    apiBaseUrl: params.apiBaseUrl,
    fetchImpl: params.fetchImpl,
  });
  const { workspace, repo } = splitBitbucketRepositoryFullName(
    params.repositoryFullName,
  );
  const fetchImpl = params.fetchImpl ?? fetch;
  const pipelinePath = `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repo)}/pipelines/${encodeBitbucketUuid(params.pipelineUuid)}`;

  const stepsResponse = await fetchImpl(
    buildBitbucketApiUrl(auth.apiBaseUrl, `${pipelinePath}/steps/`, {
      pagelen: 50,
    }),
    {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization:
          auth.authScheme === 'bearer'
            ? `Bearer ${auth.token}`
            : buildAuthorizationHeader(auth.username, auth.token),
      },
      signal: AbortSignal.timeout(BITBUCKET_FAILURE_EVIDENCE_TIMEOUT_MS),
    },
  );

  if ([401, 403, 404].includes(stepsResponse.status)) {
    return null;
  }

  if (stepsResponse.status !== 200) {
    throw new BitbucketApiError(stepsResponse.status, stepsResponse.statusText);
  }

  const { values: steps } = bitbucketPipelineStepListSchema.parse(
    await stepsResponse.json(),
  );
  const failedSteps = steps
    .filter((step) => {
      const result = (step.state?.result?.name ?? step.state?.name ?? '')
        .trim()
        .toUpperCase();
      return result === 'FAILED' || result === 'ERROR';
    })
    .slice(0, BITBUCKET_FAILURE_EVIDENCE_MAX_STEPS);

  if (failedSteps.length === 0) {
    return null;
  }

  const evidence = await Promise.all(
    failedSteps.map(async (step) => {
      const stepUuid = step.uuid?.trim();
      if (!stepUuid) {
        return formatBitbucketPipelineStepEvidence({
          step,
          logText: null,
          logTruncated: false,
        });
      }

      try {
        const logResponse = await fetchImpl(
          buildBitbucketApiUrl(
            auth.apiBaseUrl,
            `${pipelinePath}/steps/${encodeBitbucketUuid(stepUuid)}/log`,
            {},
          ),
          {
            method: 'GET',
            headers: {
              // The step log endpoint serves application/octet-stream and
              // responds 406 to Accept: text/plain.
              Accept: 'application/octet-stream',
              Authorization:
                auth.authScheme === 'bearer'
                  ? `Bearer ${auth.token}`
                  : buildAuthorizationHeader(auth.username, auth.token),
            },
            signal: AbortSignal.timeout(BITBUCKET_FAILURE_EVIDENCE_TIMEOUT_MS),
          },
        );

        if (logResponse.status !== 200) {
          return formatBitbucketPipelineStepEvidence({
            step,
            logText: null,
            logTruncated: false,
          });
        }

        const tail = await readResponseTextTail(
          logResponse,
          BITBUCKET_FAILURE_EVIDENCE_TRACE_CHARS,
        );
        return formatBitbucketPipelineStepEvidence({
          step,
          logText: tail.text.trim() || null,
          logTruncated: tail.truncated,
        });
      } catch {
        return formatBitbucketPipelineStepEvidence({
          step,
          logText: null,
          logTruncated: false,
        });
      }
    }),
  );

  return evidence.join('\n\n');
}
