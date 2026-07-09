import { enqueueCloudTask } from '@roomote/cloud-agents/server';
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
import { TaskPayloadKind, type SuggestedTasksTask } from '@roomote/types';

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

        // Automation scans run as the deployment service principal; a manual
        // trigger is still an automation launch, just with a manual trigger
        // kind on the task record.
        const launchResult = await enqueueCloudTask({
          task: {
            type: TaskPayloadKind.Scan,
            payload: scanTask.payload,
          },
          initiator: { kind: 'automation', key: config.automationKey },
          workflow: 'scan',
          surface: 'system',
          trigger: opts.manualTrigger ? 'manual' : 'schedule',
          visibility: 'hidden',
          channels: { slackChannelId: channelId },
        });

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
