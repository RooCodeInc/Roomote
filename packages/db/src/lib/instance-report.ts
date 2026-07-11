import {
  and,
  count,
  countDistinct,
  eq,
  gte,
  isNotNull,
  isNull,
  sum,
} from 'drizzle-orm';

import { RunStatus, getMcpIntegration } from '@roomote/types';

import { db } from '../db';
import {
  taskRuns,
  deploymentMcpEnablements,
  deploymentSettings,
  environments,
  mcpConnections,
  repositories,
  slackInstallations,
  taskInferenceUsageEvents,
  tasks,
  teamsInstallations,
  telegramUserMappings,
  userApiKeys,
  users,
} from '../schema';

const DEFAULT_DEPLOYMENT_ID = 'default';

const REPORT_WINDOW_MS = 24 * 60 * 60 * 1000;

export type InstanceReportModelUsage = {
  provider: string | null;
  model: string;
  count: number;
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

function toNumber(value: string | number | null | undefined): number {
  if (value == null) {
    return 0;
  }
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
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
