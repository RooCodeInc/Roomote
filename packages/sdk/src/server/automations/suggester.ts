import { findEnvironmentForRepo } from '@roomote/cloud-agents/server';
import {
  db,
  slackInstallations,
  workItems,
  getAutomationRuntime,
  and,
  count,
  desc,
  eq,
  gte,
} from '@roomote/db/server';
import {
  FeatureFlag,
  getFeatureFlagEvaluator,
} from '@roomote/feature-flags/server';
import { getRedis } from '@roomote/redis';
import { type WorkItemStatus } from '@roomote/types';
import {
  getActiveRepositoryFullNames,
  hasAnyActiveRepository,
} from './github-deployment-scope';
import { isRunDue, resolveSlackWorkspaceTimezone } from './scheduling-utils';
import { dispatchSuggestionRoutes } from './suggester-route-dispatch';
import {
  prepareSuggestionDispatchPlan,
  type RepositoryCoverage,
  type SuggesterDeploymentContext,
} from './suggester-route-planner';
import {
  emptyJobResult,
  type AutomationJobResult,
  type AutomationRunOpts,
} from './types';

const LOG_PREFIX = '[suggester]';
const SCHEDULE_HOUR_LOCAL = 2;
const OPEN_SUGGESTION_LIMIT = 0;
const PREVIOUS_SUGGESTIONS_LOOKBACK_DAYS = 30;

const WINDOW_DAYS: Record<string, number> = {
  daily: 1,
  weekly: 7,
};

async function findEligibleDeployments(): Promise<
  SuggesterDeploymentContext[]
> {
  if (!(await hasAnyActiveRepository())) {
    return [];
  }

  return db
    .select({
      slackBotToken: slackInstallations.botAccessToken,
      slackTeamId: slackInstallations.teamId,
    })
    .from(slackInstallations)
    .where(eq(slackInstallations.isActive, true));
}

async function buildRepositoryCoverage(
  repositoryFullNames: string[],
): Promise<RepositoryCoverage> {
  return Promise.all(
    repositoryFullNames.map(async (repositoryFullName) => {
      const targetEnvironmentId =
        (await findEnvironmentForRepo(repositoryFullName)) ?? undefined;

      return targetEnvironmentId
        ? {
            repositoryFullName,
            workspaceReadiness: 'environment_backed' as const,
            targetEnvironmentId,
          }
        : {
            repositoryFullName,
            workspaceReadiness: 'bare_repo' as const,
          };
    }),
  );
}

async function getPreviousSuggestions(since: Date): Promise<
  Array<{
    title: string;
    brief: string;
    status: WorkItemStatus;
  }>
> {
  const rows = await db
    .select({
      title: workItems.title,
      brief: workItems.brief,
      status: workItems.status,
    })
    .from(workItems)
    .where(
      and(eq(workItems.kind, 'suggestion'), gte(workItems.createdAt, since)),
    )
    .orderBy(desc(workItems.createdAt))
    .limit(50);

  return rows.map((row) => ({
    title: row.title,
    brief: row.brief ?? '',
    status: row.status,
  }));
}

async function countOpenSuggestions(): Promise<number> {
  const [result] = await db
    .select({
      openSuggestionCount: count(),
    })
    .from(workItems)
    .where(and(eq(workItems.kind, 'suggestion'), eq(workItems.status, 'open')));

  return result?.openSuggestionCount ?? 0;
}

export async function suggesterJob(
  opts: AutomationRunOpts = {},
): Promise<AutomationJobResult> {
  console.log(`${LOG_PREFIX} Starting suggester evaluator`);

  const now = new Date();
  const result = emptyJobResult();
  const eligibleDeployments = await findEligibleDeployments();

  if (eligibleDeployments.length === 0) {
    result.skippedReason = 'GitHub and Slack must both be connected.';
  }

  let processed = 0;
  let skipped = 0;

  for (const deployment of eligibleDeployments) {
    try {
      const suggestionRoutingEnabled = await getFeatureFlagEvaluator(
        getRedis(),
      ).evaluate(FeatureFlag.SuggestionRouting, {
        isDeploymentContext: true,
      });
      const runtime = await getAutomationRuntime('suggester');
      const frequency = runtime.enabled ? runtime.scheduleMode : 'off';
      const channelId = runtime.slackChannelId;

      if (!frequency || frequency === 'off' || !(frequency in WINDOW_DAYS)) {
        result.skippedReason = 'Automation is disabled.';
        skipped++;
        continue;
      }

      if (!channelId) {
        console.log(
          `${LOG_PREFIX} Skipping deployment: suggester channel not configured`,
        );
        result.skippedReason = 'Suggester channel is not configured.';
        skipped++;
        continue;
      }

      const timezone = await resolveSlackWorkspaceTimezone(
        deployment,
        LOG_PREFIX,
      );

      if (
        !opts.manualTrigger &&
        !isRunDue({
          now,
          timeZone: timezone,
          frequency,
          lastRunAt: runtime.lastRunAt,
          scheduleHourLocal: SCHEDULE_HOUR_LOCAL,
          windowDays: WINDOW_DAYS,
        })
      ) {
        result.skippedReason = 'Not due yet.';
        skipped++;
        continue;
      }

      const openSuggestionCount = await countOpenSuggestions();

      if (
        OPEN_SUGGESTION_LIMIT > 0 &&
        openSuggestionCount >= OPEN_SUGGESTION_LIMIT
      ) {
        console.log(
          `${LOG_PREFIX} Skipping deployment: 25 or more open suggestions already exist`,
        );
        result.skippedReason = 'Too many open suggestions already exist.';
        skipped++;
        continue;
      }

      const repositoryFullNames = await getActiveRepositoryFullNames();

      if (repositoryFullNames.length === 0) {
        console.log(
          `${LOG_PREFIX} Skipping deployment: no repositories available for suggestion scan`,
        );
        result.skippedReason =
          'No repositories are available for a suggestion scan.';
        skipped++;
        continue;
      }

      const previousSuggestionsSince = new Date(
        now.getTime() -
          PREVIOUS_SUGGESTIONS_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
      );
      const [repositoryCoverage, previousSuggestions] = await Promise.all([
        buildRepositoryCoverage(repositoryFullNames),
        getPreviousSuggestions(previousSuggestionsSince),
      ]);
      const environmentBackedRepositoryCoverage = repositoryCoverage.filter(
        (
          coverage,
        ): coverage is {
          repositoryFullName: string;
          workspaceReadiness: 'environment_backed';
          targetEnvironmentId: string;
        } => Boolean(coverage.targetEnvironmentId),
      );
      const environmentBackedRepositoryFullNames =
        environmentBackedRepositoryCoverage.map(
          (coverage) => coverage.repositoryFullName,
        );

      if (environmentBackedRepositoryFullNames.length === 0) {
        console.log(
          `${LOG_PREFIX} Skipping deployment: no repositories present in configured environments for suggestion scan`,
        );
        result.skippedReason =
          'No repositories are covered by a configured environment.';
        skipped++;
        continue;
      }

      if (previousSuggestions.length > 0) {
        console.log(
          `${LOG_PREFIX} Feeding ${previousSuggestions.length} prior suggestion(s) into prompt`,
        );
      }

      const routePlan = await prepareSuggestionDispatchPlan({
        deployment,
        groupedRoutingEnabled: suggestionRoutingEnabled,
        managerChannelId: channelId,
        now,
        repositoryCoverage,
        settings: {
          suggesterInstructions: runtime.instructions,
          suggesterRoutingInstructions:
            typeof runtime.settings.routingInstructions === 'string'
              ? runtime.settings.routingInstructions
              : null,
          suggesterRoutingMode:
            typeof runtime.settings.routingMode === 'string'
              ? runtime.settings.routingMode
              : null,
        },
      });
      const dispatchResult = await dispatchSuggestionRoutes({
        deployment,
        previousSuggestions,
        repositoryCoverage: environmentBackedRepositoryCoverage,
        repositoryFullNames: environmentBackedRepositoryFullNames,
        routePlan,
        triggerKind: opts.manualTrigger ? 'manual' : 'scheduled',
      });

      if (dispatchResult.successfulRoutes > 0) {
        processed++;
        result.launchedTaskId ??= dispatchResult.firstLaunchedTaskId;
      }

      result.errors.push(...dispatchResult.errors);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(message);
      console.error(`${LOG_PREFIX} Failed deployment: ${message}`);
    }
  }

  console.log(
    `${LOG_PREFIX} Completed: ${processed} processed, ${skipped} skipped, ${result.errors.length} errors`,
  );

  if (result.errors.length > 0) {
    console.error(`${LOG_PREFIX} Errors:`, result.errors);
  }

  return result;
}
