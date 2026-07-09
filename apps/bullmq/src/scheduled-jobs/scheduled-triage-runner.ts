import {
  deploymentHasActiveCredentialUser,
  enqueueCloudTask,
} from '@roomote/cloud-agents/server';
import {
  completeBackgroundAutomationRun,
  completeBackgroundAutomationRunByJobId,
  db,
  eq,
  getBackgroundAgentSettingsForDeployment,
  resolveManagerSlackChannelId,
  slackInstallations,
  startBackgroundAutomationRun,
} from '@roomote/db/server';
import { CloudTaskType, type SuggestedTasksTask } from '@roomote/types';

import {
  isRunDue,
  resolveSlackWorkspaceTimezone,
  type SlackDeploymentContext,
} from './scheduling-utils';
import { postScheduledTriageRoutingDebug } from './triage-routing-debug';

const SCHEDULE_HOUR_LOCAL = 3;

const WINDOW_DAYS: Record<string, number> = {
  daily: 1,
  weekly: 7,
};

type TriageDeploymentContext = SlackDeploymentContext;

type TriageAutomationSettings = Awaited<
  ReturnType<typeof getBackgroundAgentSettingsForDeployment>
>;

export type TriageScanBuild =
  | { kind: 'scan'; payload: SuggestedTasksTask['payload'] }
  | { kind: 'skip'; reason: string };

type ScheduledTriageAutomationConfig = {
  automationKey: 'sentry_triage' | 'dependabot_triage' | 'ci_failure_triage';
  /** Queue/job source tag passed to the cloud task enqueue options. */
  enqueueSource: string;
  managerChannelKind: 'sentryTriage' | 'dependabotTriage' | 'ciFailureTriage';
  frequencyKey:
    | 'sentryTriageFrequency'
    | 'dependabotTriageFrequency'
    | 'ciFailureTriageFrequency';
  lastRunAtKey:
    | 'sentryTriageLastRunAt'
    | 'dependabotTriageLastRunAt'
    | 'ciFailureTriageLastRunAt';
  /**
   * Builds the scan task payload for the deployment, or skips with a logged
   * reason (missing credentials, no eligible repositories, ...).
   */
  buildScanTask: (params: {
    deployment: TriageDeploymentContext;
    channelId: string;
    settings: TriageAutomationSettings;
    manualTrigger: boolean;
  }) => Promise<TriageScanBuild>;
};

async function findEligibleDeploymentContexts(): Promise<
  TriageDeploymentContext[]
> {
  const rows = await db
    .select({
      botAccessToken: slackInstallations.botAccessToken,
      teamId: slackInstallations.teamId,
    })
    .from(slackInstallations)
    .where(eq(slackInstallations.isActive, true));

  return rows.map((installation) => ({
    slackBotToken: installation.botAccessToken,
    slackTeamId: installation.teamId,
  }));
}

export function createScheduledTriageJob(
  config: ScheduledTriageAutomationConfig,
): (opts?: { manualTrigger?: boolean; bullmqJobId?: string }) => Promise<void> {
  const jobSlug = config.automationKey.replaceAll('_', '-');
  const logPrefix = `[${jobSlug}]`;

  return async function scheduledTriageJob(
    opts: {
      manualTrigger?: boolean;
      bullmqJobId?: string;
    } = {},
  ): Promise<void> {
    console.log(
      `${logPrefix} Starting ${config.automationKey.replaceAll('_', ' ')} evaluator`,
    );

    const now = new Date();
    const eligibleDeployments = await findEligibleDeploymentContexts();

    let processed = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (const deployment of eligibleDeployments) {
      let runId: string | null = null;

      try {
        const settings = await getBackgroundAgentSettingsForDeployment();
        const frequency = settings[config.frequencyKey];

        if (frequency === 'off') {
          skipped++;
          continue;
        }

        const channelId = resolveManagerSlackChannelId(
          settings,
          config.managerChannelKind,
        );

        if (!channelId) {
          await postScheduledTriageRoutingDebug({
            automationKey: config.automationKey,
            slackBotToken: deployment.slackBotToken,
            manualTrigger: opts.manualTrigger === true,
            outcome: 'skipped',
            taskSlackChannelId: null,
            details:
              'Manager channel not configured, so the task was not queued.',
          });
          console.log(
            `${logPrefix} Skipping deployment: manager channel not configured`,
          );
          skipped++;
          continue;
        }

        const timezone = await resolveSlackWorkspaceTimezone(
          deployment,
          logPrefix,
        );

        if (
          !opts.manualTrigger &&
          !isRunDue({
            now,
            timeZone: timezone,
            frequency,
            lastRunAt: settings[config.lastRunAtKey],
            scheduleHourLocal: SCHEDULE_HOUR_LOCAL,
            windowDays: WINDOW_DAYS,
          })
        ) {
          skipped++;
          continue;
        }

        // Automation tasks enqueue with a null userId, but token minting
        // still needs at least one active user's credentials. Skip up front
        // so the run is not recorded as succeeded when the job could never
        // start.
        if (!(await deploymentHasActiveCredentialUser())) {
          console.warn(
            `${logPrefix} Skipping deployment: no active user available to resolve credentials for scheduled ${config.automationKey.replaceAll('_', ' ')} task`,
          );
          skipped++;
          continue;
        }

        const scanTask = await config.buildScanTask({
          deployment,
          channelId,
          settings,
          manualTrigger: opts.manualTrigger === true,
        });

        if (scanTask.kind === 'skip') {
          console.log(`${logPrefix} Skipping deployment: ${scanTask.reason}`);
          skipped++;
          continue;
        }

        runId = (
          await startBackgroundAutomationRun(db, {
            automationKey: config.automationKey,
            bullmqJobId:
              opts.bullmqJobId ?? `${jobSlug}:${crypto.randomUUID()}`,
            triggerKind: opts.manualTrigger ? 'manual' : 'scheduled',
            startedAt: new Date(),
          })
        ).id;

        const launchResult = await enqueueCloudTask(
          {
            // Automation-initiated: no stamped user id. Attribution comes
            // from the suggestion source, and credentials resolve at
            // token-mint time.
            userId: null,
            type: CloudTaskType.SuggestedTasks,
            payload: scanTask.payload,
          },
          {
            launchClass: opts.manualTrigger ? 'human' : 'automation',
          },
        );

        await completeBackgroundAutomationRun(db, {
          runId,
          automationKey: config.automationKey,
          status: 'succeeded',
          finishedAt: new Date(),
          taskId: launchResult.taskId,
          metadata: { cloudJobId: launchResult.id },
        });

        await postScheduledTriageRoutingDebug({
          automationKey: config.automationKey,
          slackBotToken: deployment.slackBotToken,
          manualTrigger: opts.manualTrigger === true,
          outcome: 'queued',
          taskSlackChannelId: channelId,
        });

        processed++;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(message);
        if (runId) {
          await completeBackgroundAutomationRun(db, {
            runId,
            automationKey: config.automationKey,
            status: 'failed',
            finishedAt: new Date(),
            error: message,
          });
        } else if (opts.bullmqJobId) {
          await completeBackgroundAutomationRunByJobId(db, {
            automationKey: config.automationKey,
            bullmqJobId: opts.bullmqJobId,
            status: 'failed',
            finishedAt: new Date(),
            error: message,
          });
        }
        console.error(`${logPrefix} Failed deployment: ${message}`);
      }
    }

    console.log(
      `${logPrefix} Completed: ${processed} processed, ${skipped} skipped, ${errors.length} errors`,
    );

    if (errors.length > 0) {
      console.error(`${logPrefix} Errors:`, errors);
    }
  };
}
