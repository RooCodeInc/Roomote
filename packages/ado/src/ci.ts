import { z } from 'zod';

import {
  ADO_API_VERSION,
  buildAdoApiUrl,
  buildAdoAuthorizationHeader,
  parseAdoRepositoryFullName,
  resolveAdoOrganizationApiBaseUrl,
  resolveAdoToken,
} from './api';

const ADO_FAILURE_EVIDENCE_MAX_TASKS = 5;
const ADO_FAILURE_EVIDENCE_TRACE_CHARS = 6_000;
const ADO_BUILD_INSPECTION_TIMEOUT_MS = 5_000;

const adoBuildSchema = z
  .object({
    id: z.number(),
    buildNumber: z.string().optional(),
    status: z.string().optional(),
    result: z.string().nullable().optional(),
    sourceBranch: z.string().optional(),
    sourceVersion: z.string().optional(),
    reason: z.string().optional(),
    url: z.string().optional(),
    definition: z
      .object({ id: z.number().optional(), name: z.string().optional() })
      .passthrough()
      .optional(),
    project: z
      .object({ id: z.string().optional(), name: z.string().optional() })
      .passthrough()
      .optional(),
    repository: z
      .object({
        id: z.string().optional(),
        name: z.string().optional(),
        type: z.string().optional(),
      })
      .passthrough()
      .optional(),
    _links: z
      .object({
        web: z.object({ href: z.string().optional() }).passthrough().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
const adoBuildListResponseSchema = z.object({
  count: z.number().optional(),
  value: z.array(adoBuildSchema),
});
const adoTimelineRecordSchema = z
  .object({
    id: z.string().optional(),
    parentId: z.string().nullable().optional(),
    name: z.string().optional(),
    type: z.string().optional(),
    result: z.string().nullable().optional(),
    state: z.string().optional(),
    log: z
      .object({ id: z.number().optional(), url: z.string().optional() })
      .passthrough()
      .nullish(),
    issues: z
      .array(
        z
          .object({
            type: z.string().optional(),
            category: z.string().optional(),
            message: z.string().optional(),
          })
          .passthrough(),
      )
      .nullish(),
  })
  .passthrough();
const adoTimelineSchema = z
  .object({ records: z.array(adoTimelineRecordSchema).optional() })
  .passthrough();

export type AdoBuild = z.infer<typeof adoBuildSchema>;
type AdoTimelineRecord = z.infer<typeof adoTimelineRecordSchema>;

function timelineRecordParentId(record: AdoTimelineRecord): string | undefined {
  const parentId = record.parentId;
  return typeof parentId === 'string' && parentId.trim() ? parentId : undefined;
}

export function selectInnermostFailedAdoTimelineRecords(
  records: AdoTimelineRecord[],
): AdoTimelineRecord[] {
  const failed = records.filter(
    (record) => (record.result ?? '').toLowerCase() === 'failed',
  );
  if (failed.length === 0) return [];
  const allById = new Map(
    records
      .filter((record): record is AdoTimelineRecord & { id: string } =>
        Boolean(record.id?.trim()),
      )
      .map((record) => [record.id, record]),
  );
  const hasParentLinks = failed.some((record) =>
    Boolean(timelineRecordParentId(record)),
  );
  if (hasParentLinks) {
    const hasFailedDescendant = (record: AdoTimelineRecord): boolean => {
      if (!record.id) return false;
      for (const other of failed) {
        if (other === record) continue;
        let cursor = timelineRecordParentId(other);
        const seen = new Set<string>();
        while (cursor && !seen.has(cursor)) {
          if (cursor === record.id) return true;
          seen.add(cursor);
          cursor = timelineRecordParentId(allById.get(cursor) ?? {});
        }
      }
      return false;
    };
    const leaves = failed.filter((record) => !hasFailedDescendant(record));
    const typedLeaves = leaves.filter(
      (record) =>
        ['task', 'job'].includes((record.type ?? '').toLowerCase()) ||
        Boolean(record.name?.trim()),
    );
    return (typedLeaves.length > 0 ? typedLeaves : leaves).slice(
      0,
      ADO_FAILURE_EVIDENCE_MAX_TASKS,
    );
  }
  const failedOfType = (type: string) =>
    failed.filter((record) => (record.type ?? '').toLowerCase() === type);
  const failedTasks = failedOfType('task');
  const failedJobs = failedOfType('job');
  const failedNamed = failed.filter((record) => Boolean(record.name?.trim()));
  return (
    failedTasks.length > 0
      ? failedTasks
      : failedJobs.length > 0
        ? failedJobs
        : failedNamed
  ).slice(0, ADO_FAILURE_EVIDENCE_MAX_TASKS);
}

function buildAdoBranchRef(branch: string): string {
  const trimmed = branch.trim();
  return !trimmed
    ? 'refs/heads/main'
    : trimmed.startsWith('refs/')
      ? trimmed
      : `refs/heads/${trimmed}`;
}

export function getAdoBuildWebUrl(build: AdoBuild): string {
  return (
    build._links?.web?.href?.trim() || build.url?.trim() || `build/${build.id}`
  );
}

export async function getLatestAdoBuild(params: {
  repositoryFullName: string;
  repositoryId: string;
  branch: string;
  token?: string;
  organization?: string;
  baseUrl?: string;
  organizationApiBaseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<AdoBuild | null> {
  const adoToken = params.token ?? (await resolveAdoToken());
  if (!adoToken?.trim())
    throw new Error('ADO_TOKEN is required to inspect Azure DevOps builds.');
  const parsed = parseAdoRepositoryFullName(params.repositoryFullName);
  const organizationApiBaseUrl = await resolveAdoOrganizationApiBaseUrl({
    organization: params.organization ?? parsed.organization,
    baseUrl: params.baseUrl,
    organizationApiBaseUrl: params.organizationApiBaseUrl,
  });
  if (!organizationApiBaseUrl)
    throw new Error(
      'ADO_ORGANIZATION is required to inspect Azure DevOps builds.',
    );
  const response = await (params.fetchImpl ?? fetch)(
    buildAdoApiUrl(
      organizationApiBaseUrl,
      `/${encodeURIComponent(parsed.project)}/_apis/build/builds`,
      {
        'api-version': ADO_API_VERSION,
        repositoryId: params.repositoryId,
        repositoryType: 'TfsGit',
        branchName: buildAdoBranchRef(params.branch),
        statusFilter: 'completed',
        queryOrder: 'finishTimeDescending',
        $top: 1,
      },
    ),
    {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: buildAdoAuthorizationHeader(adoToken),
      },
      signal: AbortSignal.timeout(ADO_BUILD_INSPECTION_TIMEOUT_MS),
    },
  );
  if ([203, 401, 403].includes(response.status))
    throw new Error(
      `Azure DevOps rejected the access token when listing builds (status ${response.status}). Confirm it is active, belongs to the organization, and has Build read access.`,
    );
  if (response.status === 404) return null;
  if (response.status !== 200)
    throw new Error(
      `Azure DevOps API request failed: ${response.status} ${response.statusText}`,
    );
  return (
    adoBuildListResponseSchema.parse(await response.json()).value[0] ?? null
  );
}

async function readResponseTextTail(
  response: Response,
  maxChars: number,
): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) {
    const text = await response.text();
    return { text: text.slice(-maxChars), truncated: text.length > maxChars };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let tail = '';
  let totalChars = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    totalChars += chunk.length;
    tail = `${tail}${chunk}`.slice(-maxChars);
  }
  const finalChunk = decoder.decode();
  totalChars += finalChunk.length;
  return {
    text: `${tail}${finalChunk}`.slice(-maxChars),
    truncated: totalChars > maxChars,
  };
}

function formatAdoTimelineRecordEvidence(params: {
  record: AdoTimelineRecord;
  logText: string | null;
  logTruncated: boolean;
}): string {
  const issues = (params.record.issues ?? [])
    .map((issue) => issue.message?.trim())
    .filter((message): message is string => Boolean(message));
  const metadata = [
    `task=${JSON.stringify(params.record.name ?? 'unknown')}`,
    ...(params.record.type
      ? [`type=${JSON.stringify(params.record.type)}`]
      : []),
    ...(params.record.result
      ? [`result=${JSON.stringify(params.record.result)}`]
      : []),
  ].join(' ');
  const issueBlock =
    issues.length > 0
      ? `\nIssues:\n${issues.map((message) => `- ${message}`).join('\n')}`
      : '';
  if (!params.logText)
    return `${metadata}${issueBlock}${issueBlock ? '' : '\nLog trace unavailable.'}`;
  return `${metadata}${issueBlock}\n${params.logTruncated ? '[Earlier log output omitted; showing the tail.]\n' : ''}${params.logText}`;
}

export async function getAdoBuildFailureEvidence(params: {
  repositoryFullName: string;
  buildId: number;
  token?: string;
  organization?: string;
  baseUrl?: string;
  organizationApiBaseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<string | null> {
  const adoToken = params.token ?? (await resolveAdoToken());
  if (!adoToken?.trim())
    throw new Error(
      'ADO_TOKEN is required to inspect Azure DevOps build logs.',
    );
  const parsed = parseAdoRepositoryFullName(params.repositoryFullName);
  const organizationApiBaseUrl = await resolveAdoOrganizationApiBaseUrl({
    organization: params.organization ?? parsed.organization,
    baseUrl: params.baseUrl,
    organizationApiBaseUrl: params.organizationApiBaseUrl,
  });
  if (!organizationApiBaseUrl)
    throw new Error(
      'ADO_ORGANIZATION is required to inspect Azure DevOps build logs.',
    );
  const fetchImpl = params.fetchImpl ?? fetch;
  const projectPath = encodeURIComponent(parsed.project);
  const timelineResponse = await fetchImpl(
    buildAdoApiUrl(
      organizationApiBaseUrl,
      `/${projectPath}/_apis/build/builds/${params.buildId}/timeline`,
      { 'api-version': ADO_API_VERSION },
    ),
    {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: buildAdoAuthorizationHeader(adoToken),
      },
      signal: AbortSignal.timeout(ADO_BUILD_INSPECTION_TIMEOUT_MS),
    },
  );
  if ([203, 401, 403, 404].includes(timelineResponse.status)) return null;
  if (timelineResponse.status !== 200)
    throw new Error(
      `Azure DevOps API request failed: ${timelineResponse.status} ${timelineResponse.statusText}`,
    );
  const failedRecords = selectInnermostFailedAdoTimelineRecords(
    adoTimelineSchema.parse(await timelineResponse.json()).records ?? [],
  );
  if (failedRecords.length === 0) return null;
  const evidence = await Promise.all(
    failedRecords.map(async (record) => {
      const logId = record.log?.id;
      if (logId === undefined)
        return formatAdoTimelineRecordEvidence({
          record,
          logText: null,
          logTruncated: false,
        });
      try {
        const logResponse = await fetchImpl(
          buildAdoApiUrl(
            organizationApiBaseUrl,
            `/${projectPath}/_apis/build/builds/${params.buildId}/logs/${logId}`,
            { 'api-version': ADO_API_VERSION },
          ),
          {
            method: 'GET',
            headers: {
              Accept: 'text/plain',
              Authorization: buildAdoAuthorizationHeader(adoToken),
            },
            signal: AbortSignal.timeout(ADO_BUILD_INSPECTION_TIMEOUT_MS),
          },
        );
        if (logResponse.status !== 200)
          return formatAdoTimelineRecordEvidence({
            record,
            logText: null,
            logTruncated: false,
          });
        const tail = await readResponseTextTail(
          logResponse,
          ADO_FAILURE_EVIDENCE_TRACE_CHARS,
        );
        return formatAdoTimelineRecordEvidence({
          record,
          logText: tail.text.trim() || null,
          logTruncated: tail.truncated,
        });
      } catch {
        return formatAdoTimelineRecordEvidence({
          record,
          logText: null,
          logTruncated: false,
        });
      }
    }),
  );
  return evidence.join('\n\n');
}
