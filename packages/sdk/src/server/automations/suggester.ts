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
  getAutomationAdditionalRules,
  sourceControlProviders,
  type WorkItemStatus,
} from '@roomote/types';
import {
  buildDestinationTaskPayloadFields,
  listConnectedCommunicationProviders,
  resolveAutomationRuntimeDestination,
  type ResolvedAutomationDestination,
} from './destination';
import {
  findEnvironmentIdForRepositoryId,
  getActiveRepositoriesForProviders,
  hasAnyActiveRepository,
  type ActiveRepositoryProviderPartition,
} from './github-deployment-scope';
import { resolveAutomationRepositoryDestination } from './ci-failure-triage-routing';
import { resolveDeploymentTimeZone } from './custom-automation-schedule';
import { isRunDue } from './scheduling-utils';
import {
  dispatchSuggestionScan,
  type RepositoryCoverage,
  type SuggesterDeploymentContext,
} from './suggester-dispatch';
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

  const rows = await db
    .select({
      slackBotToken: slackInstallations.botAccessToken,
      slackTeamId: slackInstallations.teamId,
    })
    .from(slackInstallations)
    .where(eq(slackInstallations.isActive, true));

  if (rows.length > 0) {
    return rows;
  }

  // No Slack: still eligible when another connected surface can carry
  // Suggest Ideas (Discord channel destination or Telegram sticky topic).
  const connectedProviders = await listConnectedCommunicationProviders();
  return connectedProviders.length > 0
    ? [{ slackBotToken: null, slackTeamId: null }]
    : [];
}

async function buildRepositoryCoverage(
  repositoryRefs: Array<{ id: string; fullName: string }>,
): Promise<RepositoryCoverage> {
  return Promise.all(
    repositoryRefs.map(async ({ id, fullName: repositoryFullName }) => {
      const targetEnvironmentId =
        (await findEnvironmentIdForRepositoryId(id)) ?? undefined;

      return targetEnvironmentId
        ? {
            repositoryId: id,
            repositoryFullName,
            workspaceReadiness: 'environment_backed' as const,
            targetEnvironmentId,
          }
        : {
            repositoryId: id,
            repositoryFullName,
            workspaceReadiness: 'bare_repo' as const,
          };
    }),
  );
}

function destinationKey(destination: ResolvedAutomationDestination): string {
  return JSON.stringify([
    destination.provider,
    destination.channelId,
    destination.teamId ?? null,
    destination.serviceUrl ?? null,
  ]);
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
    result.skippedReason =
      'At least one active repository and a connected communication surface are required.';
  }

  let processed = 0;
  let skipped = 0;
  const launchedRouteGroups = new Set<string>();

  for (const deployment of eligibleDeployments) {
    try {
      const runtime = await getAutomationRuntime('suggester');
      const frequency = runtime.enabled ? runtime.scheduleMode : 'off';
      const destination =
        opts.destination ??
        (await resolveAutomationRuntimeDestination({
          runtime,
          slackConnected: deployment.slackBotToken !== null,
        }));
      const channelId = destination?.channelId;
      const rules = getAutomationAdditionalRules(runtime.settings);

      if (!frequency || frequency === 'off' || !(frequency in WINDOW_DAYS)) {
        result.skippedReason = 'Automation is disabled.';
        skipped++;
        continue;
      }

      if (rules === null) {
        result.skippedReason = 'Additional rules are invalid.';
        skipped++;
        continue;
      }

      if (!channelId && (!rules || rules.destinations.length === 0)) {
        console.log(
          `${LOG_PREFIX} Skipping deployment: suggester destination not configured`,
        );
        result.skippedReason = 'Suggester destination is not configured.';
        skipped++;
        continue;
      }

      if (
        !rules &&
        destination?.provider === 'slack' &&
        destination.teamId &&
        destination.teamId !== deployment.slackTeamId
      ) {
        skipped++;
        continue;
      }

      const timezone = (await resolveDeploymentTimeZone()).timeZone;

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

      const repositoryRefs = await getActiveRepositoriesForProviders(
        sourceControlProviders,
      );
      const scopedRepositoryRefs = repositoryRefs.filter(
        (repository) =>
          rules?.repositoryIds == null ||
          rules.repositoryIds.includes(repository.id),
      );

      if (scopedRepositoryRefs.length === 0) {
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
        buildRepositoryCoverage(scopedRepositoryRefs),
        getPreviousSuggestions(previousSuggestionsSince),
      ]);
      const environmentBackedRepositoryCoverage = repositoryCoverage.filter(
        (
          coverage,
        ): coverage is {
          repositoryId: string;
          repositoryFullName: string;
          workspaceReadiness: 'environment_backed';
          targetEnvironmentId: string;
        } => Boolean(coverage.targetEnvironmentId),
      );
      const environmentBackedRepositoryIds = new Set(
        environmentBackedRepositoryCoverage.map(
          (coverage) => coverage.repositoryId,
        ),
      );
      const environmentBackedRepositories = scopedRepositoryRefs.filter(
        (repo) => environmentBackedRepositoryIds.has(repo.id),
      );

      if (environmentBackedRepositories.length === 0) {
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

      const connectedProviders = await listConnectedCommunicationProviders();
      const routeGroups = new Map<
        string,
        {
          destination: ResolvedAutomationDestination;
          repositories: typeof environmentBackedRepositories;
        }
      >();
      for (const repository of environmentBackedRepositories) {
        const repositoryDestination =
          await resolveAutomationRepositoryDestination({
            runtime,
            repositoryId: repository.id,
            connectedProviders,
            ...(destination ? { destination } : {}),
          });
        if (!repositoryDestination) continue;
        const key = destinationKey(repositoryDestination);
        const group = routeGroups.get(key);
        if (group) group.repositories.push(repository);
        else
          routeGroups.set(key, {
            destination: repositoryDestination,
            repositories: [repository],
          });
      }
      for (const [routeKey, group] of routeGroups) {
        if (
          launchedRouteGroups.has(routeKey) ||
          (group.destination.provider === 'slack' &&
            group.destination.teamId &&
            group.destination.teamId !== deployment.slackTeamId)
        ) {
          continue;
        }
        const partitions = new Map<
          string,
          ActiveRepositoryProviderPartition & { repositoryIds: string[] }
        >();
        for (const repository of group.repositories) {
          const key = `${repository.sourceControlProvider}\0${repository.host ?? ''}`;
          const partition = partitions.get(key);
          if (partition) {
            partition.repositoryFullNames.push(repository.fullName);
            partition.repositoryIds.push(repository.id);
          } else
            partitions.set(key, {
              provider: repository.sourceControlProvider,
              host: repository.host,
              repositoryFullNames: [repository.fullName],
              repositoryIds: [repository.id],
            });
        }
        const dispatchResult = await dispatchSuggestionScan({
          deployment,
          channelId: group.destination.channelId,
          now,
          suggesterInstructions: [runtime.instructions, rules?.instructions]
            .filter((value): value is string => Boolean(value?.trim()))
            .join('\n\n'),
          previousSuggestions,
          repositoryCoverage: environmentBackedRepositoryCoverage.filter(
            (coverage) =>
              group.repositories.some(
                (repository) => repository.id === coverage.repositoryId,
              ),
          ),
          repositoryPartitions: [...partitions.values()],
          triggerKind: opts.manualTrigger ? 'manual' : 'scheduled',
          destinationPayloadFields: buildDestinationTaskPayloadFields(
            group.destination,
          ),
        });
        if (dispatchResult.successfulScans > 0) {
          launchedRouteGroups.add(routeKey);
          processed++;
          result.launchedTaskId ??= dispatchResult.firstLaunchedTaskId;
        }
        result.errors.push(...dispatchResult.errors);
      }
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
