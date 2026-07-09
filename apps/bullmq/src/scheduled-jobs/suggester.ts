import {
  deploymentHasActiveCredentialUser,
  findEnvironmentForRepo,
} from '@roomote/cloud-agents/server';
import {
  db,
  slackInstallations,
  taskSuggestions,
  getBackgroundAgentSettingsForDeployment,
  count,
  desc,
  eq,
  gte,
  resolveManagerSlackChannelId,
} from '@roomote/db/server';
import {
  FeatureFlag,
  getFeatureFlagEvaluator,
} from '@roomote/feature-flags/server';
import {
  type SuggesterFrequency,
  type TaskSuggestionStatus,
} from '@roomote/types';
import { getRedis } from '../redis';
import {
  getActiveRepositoryFullNames,
  hasActiveGitHubInstallation,
} from './github-deployment-scope';
import { isRunDue, resolveSlackWorkspaceTimezone } from './scheduling-utils';
import { dispatchSuggestionRoutes } from './suggester-route-dispatch';
import {
  prepareSuggestionDispatchPlan,
  type RepositoryCoverage,
  type SuggesterDeploymentContext,
} from './suggester-route-planner';

const LOG_PREFIX = '[suggester]';
const SCHEDULE_HOUR_LOCAL = 2;
const OPEN_SUGGESTION_LIMIT = 0;
const PREVIOUS_SUGGESTIONS_LOOKBACK_DAYS = 30;

const WINDOW_DAYS: Record<Exclude<SuggesterFrequency, 'off'>, number> = {
  daily: 1,
  weekly: 7,
};

async function findEligibleDeployments(): Promise<
  SuggesterDeploymentContext[]
> {
  if (!(await hasActiveGitHubInstallation())) {
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
    status: TaskSuggestionStatus;
  }>
> {
  return db
    .select({
      title: taskSuggestions.title,
      brief: taskSuggestions.brief,
      status: taskSuggestions.status,
    })
    .from(taskSuggestions)
    .where(gte(taskSuggestions.createdAt, since))
    .orderBy(desc(taskSuggestions.createdAt))
    .limit(50);
}

async function countOpenSuggestions(): Promise<number> {
  const [result] = await db
    .select({
      openSuggestionCount: count(),
    })
    .from(taskSuggestions)
    .where(eq(taskSuggestions.status, 'open'));

  return result?.openSuggestionCount ?? 0;
}

export async function suggesterJob(
  opts: { manualTrigger?: boolean; bullmqJobId?: string } = {},
): Promise<void> {
  console.log(`${LOG_PREFIX} Starting suggester evaluator`);

  const now = new Date();
  const eligibleDeployments = await findEligibleDeployments();

  let processed = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const deployment of eligibleDeployments) {
    try {
      const suggestionRoutingEnabled = await getFeatureFlagEvaluator(
        getRedis(),
      ).evaluate(FeatureFlag.SuggestionRouting, {
        isDeploymentContext: true,
      });
      const settings = await getBackgroundAgentSettingsForDeployment();
      const channelId = resolveManagerSlackChannelId(settings, 'suggester');

      if (settings.suggesterFrequency === 'off') {
        skipped++;
        continue;
      }

      if (!channelId) {
        console.log(
          `${LOG_PREFIX} Skipping deployment: suggester channel not configured`,
        );
        skipped++;
        continue;
      }

      const frequency = settings.suggesterFrequency;
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
          lastRunAt: settings.suggesterLastRunAt,
          scheduleHourLocal: SCHEDULE_HOUR_LOCAL,
          windowDays: WINDOW_DAYS,
        })
      ) {
        skipped++;
        continue;
      }

      // Automation tasks enqueue with a null userId, but token minting still
      // needs at least one active user's credentials. Skip up front so the
      // run is not recorded as launched when the job could never start.
      if (!(await deploymentHasActiveCredentialUser())) {
        console.warn(
          `${LOG_PREFIX} Skipping deployment: no active user available to resolve credentials for scheduled suggester task`,
        );
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
        skipped++;
        continue;
      }

      const repositoryFullNames = await getActiveRepositoryFullNames();

      if (repositoryFullNames.length === 0) {
        console.log(
          `${LOG_PREFIX} Skipping deployment: no repositories available for suggestion scan`,
        );
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
        skipped++;
        continue;
      }

      if (previousSuggestions.length > 0) {
        console.log(
          `${LOG_PREFIX} Feeding ${previousSuggestions.length} prior suggestion(s) into prompt`,
        );
      }

      const baseJobId = opts.bullmqJobId ?? `suggester:${crypto.randomUUID()}`;
      const routePlan = await prepareSuggestionDispatchPlan({
        baseJobId,
        deployment,
        groupedRoutingEnabled: suggestionRoutingEnabled,
        managerChannelId: channelId,
        now,
        repositoryCoverage,
        settings: {
          suggesterInstructions: settings.suggesterInstructions,
          suggesterRoutingInstructions: settings.suggesterRoutingInstructions,
          suggesterRoutingMode: settings.suggesterRoutingMode,
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
      }

      errors.push(...dispatchResult.errors);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(message);
      console.error(`${LOG_PREFIX} Failed deployment: ${message}`);
    }
  }

  console.log(
    `${LOG_PREFIX} Completed: ${processed} processed, ${skipped} skipped, ${errors.length} errors`,
  );

  if (errors.length > 0) {
    console.error(`${LOG_PREFIX} Errors:`, errors);
  }
}
