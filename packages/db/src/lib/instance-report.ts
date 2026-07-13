import {
  and,
  count,
  countDistinct,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  notInArray,
  or,
  sum,
} from 'drizzle-orm';

import {
  RunStatus,
  getMcpIntegration,
  type PullRequestStatus,
} from '@roomote/types';

import { db } from '../db';
import {
  taskRuns,
  deploymentMcpEnablements,
  deploymentSettings,
  environments,
  mcpConnections,
  pullRequestFacts,
  repositories,
  slackInstallations,
  taskInferenceUsageEvents,
  taskPullRequests,
  tasks,
  teamsInstallations,
  telegramUserMappings,
  userApiKeys,
  users,
} from '../schema';

const DEFAULT_DEPLOYMENT_ID = 'default';

const REPORT_WINDOW_MS = 24 * 60 * 60 * 1000;
const PR_REPORT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Workflows that attach to an existing PR rather than opening one. */
const PRODUCT_OPENED_WORKFLOW_EXCLUSIONS = [
  'pr_review',
  'pr_conflict_resolve',
] as const;

export type InstanceReportModelUsage = {
  provider: string | null;
  model: string;
  count: number;
};

export type InstanceReportPullRequests7d = {
  /** Distinct product-authored PRs first associated in the trailing 7 days. */
  opened: number;
  /** Current disposition of that cohort; draft counts as still open. */
  open: number;
  closed: number;
  merged: number;
  /**
   * Median seconds from remote PR creation to merge among the merged subset
   * when a matching `pull_request_facts` row exists. Null when none of the
   * merged PRs have facts (for example non-GitHub providers or avoided sync).
   */
  medianTimeToMergeSeconds: number | null;
};

/**
 * Anonymous daily instance stats blob sent to the Ping service and forwarded
 * to PostHog. Extensible: add fields freely, never repurpose existing ones.
 * Contains only aggregate counts and provider/product names, never customer
 * data, repository names, or user identifiers.
 */
export type InstanceReportStats = {
  reportSchemaVersion: 1;
  instanceCreatedAt: string | null;
  setupCompletedAt: string | null;
  users: {
    total: number;
    admins: number;
    active24h: number;
  };
  environments: {
    total: number;
  };
  repositories: {
    total: number;
    byProvider: Record<string, number>;
  };
  tasks24h: {
    created: number;
    completed: number;
    byHarness: Record<string, number>;
    byModel: InstanceReportModelUsage[];
    tokens: {
      input: number;
      output: number;
      total: number;
      costMicroUsd: number;
    };
  };
  /**
   * Product PR funnel over the trailing 7 days, derived from local
   * `task_pull_requests` (+ optional `pull_request_facts` for merge timing).
   * No live source-control API calls.
   */
  pullRequests7d: InstanceReportPullRequests7d;
  providers: {
    comms: string[];
    sourceControl: string[];
    compute: string | null;
    inference: string[];
  };
  mcp: {
    enabled: string[];
  };
};

type AuthoredPullRequestRow = {
  sourceControlProvider: string;
  repository: string | null;
  repositoryId: string | null;
  prNumber: number | null;
  prUrl: string;
  status: PullRequestStatus | null;
  detectedAt: Date;
  updatedAt: Date;
};

type DedupedAuthoredPullRequest = {
  key: string;
  repository: string | null;
  repositoryId: string | null;
  prNumber: number | null;
  status: PullRequestStatus | null;
  firstDetectedAt: Date;
};

function toNumber(value: string | number | null | undefined): number {
  if (value == null) {
    return 0;
  }
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function getAuthoredPullRequestKey(row: {
  sourceControlProvider: string;
  repository: string | null;
  prNumber: number | null;
  prUrl: string;
}): string {
  if (row.repository && row.prNumber != null) {
    return `${row.sourceControlProvider}:${row.repository.toLowerCase()}#${row.prNumber}`;
  }

  return `${row.sourceControlProvider}:url:${row.prUrl.toLowerCase()}`;
}

/**
 * Draft is a form of open for product funnel reporting. Unknown/null status
 * stays in open so it is not silently dropped from the cohort.
 */
export function bucketPullRequestStatus(
  status: PullRequestStatus | null | undefined,
): 'open' | 'closed' | 'merged' {
  if (status === 'merged') {
    return 'merged';
  }
  if (status === 'closed') {
    return 'closed';
  }
  return 'open';
}

/** Sample median for a non-empty numeric list. */
export function median(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 1) {
    return sorted[mid] ?? null;
  }

  const low = sorted[mid - 1];
  const high = sorted[mid];
  if (low == null || high == null) {
    return null;
  }

  return Math.round((low + high) / 2);
}

/**
 * Deduplicate product-authored PR association rows into one current-status
 * cohort entry per PR key. The earliest detection wins the "opened" time;
 * the latest update wins the current status/repo identity.
 */
export function dedupeAuthoredPullRequests(
  rows: AuthoredPullRequestRow[],
): DedupedAuthoredPullRequest[] {
  const byKey = new Map<
    string,
    DedupedAuthoredPullRequest & { latestUpdatedAt: Date }
  >();

  for (const row of rows) {
    const key = getAuthoredPullRequestKey(row);
    const existing = byKey.get(key);

    if (!existing) {
      byKey.set(key, {
        key,
        repository: row.repository,
        repositoryId: row.repositoryId,
        prNumber: row.prNumber,
        status: row.status,
        firstDetectedAt: row.detectedAt,
        latestUpdatedAt: row.updatedAt,
      });
      continue;
    }

    if (row.detectedAt < existing.firstDetectedAt) {
      existing.firstDetectedAt = row.detectedAt;
    }

    if (row.updatedAt >= existing.latestUpdatedAt) {
      existing.latestUpdatedAt = row.updatedAt;
      existing.status = row.status;
      existing.repository = row.repository;
      existing.repositoryId = row.repositoryId;
      existing.prNumber = row.prNumber;
    }
  }

  return [...byKey.values()].map(
    ({ latestUpdatedAt: _latestUpdatedAt, ...rest }) => rest,
  );
}

export function summarizePullRequestCohort(
  deduped: DedupedAuthoredPullRequest[],
  since: Date,
  mergeDurationsSecondsByKey: Map<string, number>,
): InstanceReportPullRequests7d {
  const cohort = deduped.filter((entry) => entry.firstDetectedAt >= since);

  let open = 0;
  let closed = 0;
  let merged = 0;
  const mergeDurations: number[] = [];

  for (const entry of cohort) {
    const bucket = bucketPullRequestStatus(entry.status);
    if (bucket === 'merged') {
      merged += 1;
      const duration = mergeDurationsSecondsByKey.get(entry.key);
      if (duration != null && Number.isFinite(duration) && duration >= 0) {
        mergeDurations.push(duration);
      }
    } else if (bucket === 'closed') {
      closed += 1;
    } else {
      open += 1;
    }
  }

  return {
    opened: cohort.length,
    open,
    closed,
    merged,
    medianTimeToMergeSeconds: median(mergeDurations),
  };
}

async function collectPullRequestFactsDurations(
  cohort: DedupedAuthoredPullRequest[],
): Promise<Map<string, number>> {
  const durations = new Map<string, number>();
  const merged = cohort.filter(
    (entry) =>
      bucketPullRequestStatus(entry.status) === 'merged' &&
      entry.prNumber != null,
  );

  if (merged.length === 0) {
    return durations;
  }

  const repositoryIds = [
    ...new Set(
      merged
        .map((entry) => entry.repositoryId)
        .filter((id): id is string => id != null),
    ),
  ];
  const repositoryNames = [
    ...new Set(
      merged
        .map((entry) => entry.repository)
        .filter((name): name is string => Boolean(name)),
    ),
  ];
  const prNumbers = [
    ...new Set(
      merged
        .map((entry) => entry.prNumber)
        .filter((n): n is number => n != null),
    ),
  ];

  if (prNumbers.length === 0) {
    return durations;
  }

  const filters = [];
  if (repositoryIds.length > 0) {
    filters.push(inArray(pullRequestFacts.repositoryId, repositoryIds));
  }
  if (repositoryNames.length > 0) {
    filters.push(inArray(pullRequestFacts.repositoryFullName, repositoryNames));
  }

  if (filters.length === 0) {
    return durations;
  }

  const factRows = await db
    .select({
      repositoryId: pullRequestFacts.repositoryId,
      repositoryFullName: pullRequestFacts.repositoryFullName,
      prNumber: pullRequestFacts.prNumber,
      createdAtRemote: pullRequestFacts.createdAtRemote,
      mergedAtRemote: pullRequestFacts.mergedAtRemote,
    })
    .from(pullRequestFacts)
    .where(
      and(
        inArray(pullRequestFacts.prNumber, prNumbers),
        isNotNull(pullRequestFacts.mergedAtRemote),
        or(...filters),
      ),
    );

  const factsByRepoIdPr = new Map<string, number>();
  const factsByNamePr = new Map<string, number>();

  for (const fact of factRows) {
    if (!fact.mergedAtRemote) {
      continue;
    }
    const seconds = Math.round(
      (fact.mergedAtRemote.getTime() - fact.createdAtRemote.getTime()) / 1000,
    );
    if (!Number.isFinite(seconds) || seconds < 0) {
      continue;
    }

    factsByRepoIdPr.set(`${fact.repositoryId}#${fact.prNumber}`, seconds);
    factsByNamePr.set(
      `${fact.repositoryFullName.toLowerCase()}#${fact.prNumber}`,
      seconds,
    );
  }

  for (const entry of merged) {
    if (entry.prNumber == null) {
      continue;
    }

    let seconds: number | undefined;
    if (entry.repositoryId) {
      seconds = factsByRepoIdPr.get(`${entry.repositoryId}#${entry.prNumber}`);
    }
    if (seconds == null && entry.repository) {
      seconds = factsByNamePr.get(
        `${entry.repository.toLowerCase()}#${entry.prNumber}`,
      );
    }

    if (seconds != null) {
      durations.set(entry.key, seconds);
    }
  }

  return durations;
}

const authoredPullRequestSelect = {
  sourceControlProvider: taskPullRequests.sourceControlProvider,
  repository: taskPullRequests.repository,
  repositoryId: taskPullRequests.repositoryId,
  prNumber: taskPullRequests.prNumber,
  prUrl: taskPullRequests.prUrl,
  status: taskPullRequests.status,
  detectedAt: taskPullRequests.detectedAt,
  updatedAt: taskPullRequests.updatedAt,
} as const;

/**
 * Product-opened PR associations for the funnel. Source-control automation
 * workflows that attach to an existing PR (`pr_review`, `pr_conflict_resolve`)
 * are excluded so the funnel measures PRs Roomote opened, not PRs it only
 * reviewed or conflict-resolved.
 */
async function collectAuthoredPullRequestRows(
  since?: Date,
): Promise<AuthoredPullRequestRow[]> {
  return db
    .select(authoredPullRequestSelect)
    .from(taskPullRequests)
    .innerJoin(tasks, eq(tasks.id, taskPullRequests.taskId))
    .where(
      and(
        since ? gte(taskPullRequests.detectedAt, since) : undefined,
        notInArray(tasks.workflow, [...PRODUCT_OPENED_WORKFLOW_EXCLUSIONS]),
      ),
    );
}

/**
 * For PR keys that appear in the trailing window, load the full product-opened
 * association history so first-detection is first-ever, not first-in-window.
 * That keeps older PRs which are only re-linked later out of the opened cohort.
 */
async function collectAuthoredPullRequestHistoryForKeys(
  seedRows: AuthoredPullRequestRow[],
): Promise<AuthoredPullRequestRow[]> {
  if (seedRows.length === 0) {
    return [];
  }

  const repositoryNames = [
    ...new Set(
      seedRows
        .map((row) => row.repository)
        .filter((name): name is string => Boolean(name)),
    ),
  ];
  const prNumbers = [
    ...new Set(
      seedRows.map((row) => row.prNumber).filter((n): n is number => n != null),
    ),
  ];
  const prUrls = [
    ...new Set(
      seedRows
        .filter((row) => !row.repository || row.prNumber == null)
        .map((row) => row.prUrl),
    ),
  ];

  const clauses = [];
  if (repositoryNames.length > 0 && prNumbers.length > 0) {
    clauses.push(
      and(
        inArray(taskPullRequests.repository, repositoryNames),
        inArray(taskPullRequests.prNumber, prNumbers),
      ),
    );
  }
  if (prUrls.length > 0) {
    clauses.push(inArray(taskPullRequests.prUrl, prUrls));
  }

  if (clauses.length === 0) {
    return seedRows;
  }

  // Repository × prNumber is a cross product of the seed attributes, so tightening
  // in app to the exact seed keys avoids counting unrelated (repo, number) pairs.
  const seedKeys = new Set(seedRows.map(getAuthoredPullRequestKey));
  const historyRows = await db
    .select(authoredPullRequestSelect)
    .from(taskPullRequests)
    .innerJoin(tasks, eq(tasks.id, taskPullRequests.taskId))
    .where(
      and(
        notInArray(tasks.workflow, [...PRODUCT_OPENED_WORKFLOW_EXCLUSIONS]),
        or(...clauses),
      ),
    );

  return historyRows.filter((row) =>
    seedKeys.has(getAuthoredPullRequestKey(row)),
  );
}

async function collectPullRequests7d(
  now: Date,
): Promise<InstanceReportPullRequests7d> {
  const since = new Date(now.getTime() - PR_REPORT_WINDOW_MS);
  const seedRows = await collectAuthoredPullRequestRows(since);
  const historyRows = await collectAuthoredPullRequestHistoryForKeys(seedRows);
  const deduped = dedupeAuthoredPullRequests(
    historyRows.length > 0 ? historyRows : seedRows,
  );
  // Only the merged subset of the 7d opened cohort needs facts for TTM.
  const cohort = deduped.filter((entry) => entry.firstDetectedAt >= since);
  const mergeDurationsSecondsByKey =
    await collectPullRequestFactsDurations(cohort);

  return summarizePullRequestCohort(deduped, since, mergeDurationsSecondsByKey);
}

/**
 * Aggregates the anonymous daily instance report. Read-only; safe to run
 * from any server process with database access.
 */
export async function collectInstanceReportStats(
  now: Date = new Date(),
): Promise<InstanceReportStats> {
  const since = new Date(now.getTime() - REPORT_WINDOW_MS);

  const [
    settingsRow,
    userTotals,
    adminTotals,
    activeUsers,
    environmentTotals,
    repositoriesByProvider,
    tasksCreated,
    jobsCompleted,
    tasksByHarness,
    tasksByModel,
    tokenTotals,
    slackActive,
    teamsActive,
    telegramMappings,
    inferenceProviders,
    mcpEnablements,
    mcpConnectionIds,
    pullRequests7d,
  ] = await Promise.all([
    db.query.deploymentSettings.findFirst({
      where: eq(deploymentSettings.id, DEFAULT_DEPLOYMENT_ID),
      columns: {
        createdAt: true,
        setupCompletedAt: true,
        runtimeComputeConfig: true,
      },
    }),
    db.select({ total: count() }).from(users).where(isNull(users.deletedAt)),
    db
      .select({ total: count() })
      .from(users)
      .where(and(eq(users.role, 'admin'), isNull(users.deletedAt))),
    db
      .select({ active: countDistinct(tasks.initiatorUserId) })
      .from(tasks)
      .where(
        and(gte(tasks.createdAt, since), isNotNull(tasks.initiatorUserId)),
      ),
    db
      .select({ total: count() })
      .from(environments)
      .where(eq(environments.isEval, false)),
    db
      .select({
        provider: repositories.sourceControlProvider,
        total: count(),
      })
      .from(repositories)
      .where(eq(repositories.isActive, true))
      .groupBy(repositories.sourceControlProvider),
    db
      .select({ total: count() })
      .from(tasks)
      .where(gte(tasks.createdAt, since)),
    db
      .select({ total: count() })
      .from(taskRuns)
      .where(
        and(
          eq(taskRuns.status, RunStatus.Completed),
          gte(taskRuns.completedAt, since),
        ),
      ),
    db
      .select({ harness: tasks.harness, total: count() })
      .from(tasks)
      .where(gte(tasks.createdAt, since))
      .groupBy(tasks.harness),
    db
      .select({
        provider: tasks.modelProvider,
        model: tasks.model,
        total: count(),
      })
      .from(tasks)
      .where(gte(tasks.createdAt, since))
      .groupBy(tasks.modelProvider, tasks.model),
    db
      .select({
        input: sum(taskInferenceUsageEvents.inputTokens),
        output: sum(taskInferenceUsageEvents.outputTokens),
        total: sum(taskInferenceUsageEvents.totalTokens),
        costMicroUsd: sum(taskInferenceUsageEvents.costMicroUsd),
      })
      .from(taskInferenceUsageEvents)
      .where(gte(taskInferenceUsageEvents.createdAt, since)),
    db
      .select({ total: count() })
      .from(slackInstallations)
      .where(eq(slackInstallations.isActive, true)),
    db
      .select({ total: count() })
      .from(teamsInstallations)
      .where(eq(teamsInstallations.isActive, true)),
    db.select({ total: count() }).from(telegramUserMappings),
    db.selectDistinct({ provider: userApiKeys.provider }).from(userApiKeys),
    db
      .select({ mcpId: deploymentMcpEnablements.mcpId })
      .from(deploymentMcpEnablements)
      .where(eq(deploymentMcpEnablements.enabled, true)),
    db
      .selectDistinct({ mcpId: mcpConnections.mcpId })
      .from(mcpConnections)
      .where(eq(mcpConnections.enabled, true)),
    collectPullRequests7d(now),
  ]);

  const comms: string[] = [];
  if (toNumber(slackActive[0]?.total) > 0) {
    comms.push('slack');
  }
  if (toNumber(teamsActive[0]?.total) > 0) {
    comms.push('teams');
  }
  if (toNumber(telegramMappings[0]?.total) > 0) {
    comms.push('telegram');
  }

  const repositoriesByProviderRecord: Record<string, number> = {};
  let repositoriesTotal = 0;
  for (const row of repositoriesByProvider) {
    const providerTotal = toNumber(row.total);
    repositoriesByProviderRecord[row.provider] = providerTotal;
    repositoriesTotal += providerTotal;
  }

  const byHarness: Record<string, number> = {};
  for (const row of tasksByHarness) {
    byHarness[row.harness ?? 'unknown'] = toNumber(row.total);
  }

  // Only ship catalog MCP ids; anything unrecognized (defensive: custom or
  // future ids) is reported as 'custom' so no user-authored name can leak.
  const mcpEnabled = [
    ...new Set(
      [
        ...mcpEnablements.map((row) => row.mcpId),
        ...mcpConnectionIds.map((row) => row.mcpId),
      ].map((mcpId) => (getMcpIntegration(mcpId) ? mcpId : 'custom')),
    ),
  ].sort();

  return {
    reportSchemaVersion: 1,
    instanceCreatedAt: settingsRow?.createdAt?.toISOString() ?? null,
    setupCompletedAt: settingsRow?.setupCompletedAt?.toISOString() ?? null,
    users: {
      total: toNumber(userTotals[0]?.total),
      admins: toNumber(adminTotals[0]?.total),
      active24h: toNumber(activeUsers[0]?.active),
    },
    environments: {
      total: toNumber(environmentTotals[0]?.total),
    },
    repositories: {
      total: repositoriesTotal,
      byProvider: repositoriesByProviderRecord,
    },
    tasks24h: {
      created: toNumber(tasksCreated[0]?.total),
      completed: toNumber(jobsCompleted[0]?.total),
      byHarness,
      byModel: tasksByModel.map((row) => ({
        provider: row.provider,
        model: row.model,
        count: toNumber(row.total),
      })),
      tokens: {
        input: toNumber(tokenTotals[0]?.input),
        output: toNumber(tokenTotals[0]?.output),
        total: toNumber(tokenTotals[0]?.total),
        costMicroUsd: toNumber(tokenTotals[0]?.costMicroUsd),
      },
    },
    pullRequests7d,
    providers: {
      comms,
      sourceControl: Object.keys(repositoriesByProviderRecord).sort(),
      compute: settingsRow?.runtimeComputeConfig?.defaultProvider ?? null,
      inference: inferenceProviders.map((row) => row.provider).sort(),
    },
    mcp: {
      enabled: mcpEnabled,
    },
  };
}
