import { enqueueCloudTask } from '@roomote/cloud-agents/server';
import {
  db,
  eq,
  getAutomationRuntime,
  recordAutomationRunOutcome,
  slackInstallations,
  type AutomationRuntime,
} from '@roomote/db/server';
import { TaskPayloadKind, type SuggestedTasksTask } from '@roomote/types';

import {
  isRunDue,
  resolveSlackWorkspaceTimezone,
  type SlackDeploymentContext,
} from './scheduling-utils';
import { postScheduledTriageRoutingDebug } from './triage-routing-debug';
import {
  emptyJobResult,
  type AutomationJobResult,
  type AutomationRunOpts,
} from './types';

const SCHEDULE_HOUR_LOCAL = 3;

const WINDOW_DAYS: Record<string, number> = {
  daily: 1,
  weekly: 7,
};

type TriageDeploymentContext = SlackDeploymentContext;

export type TriageScanBuild =
  | { kind: 'scan'; payload: SuggestedTasksTask['payload'] }
  | { kind: 'skip'; reason: string };

type ScheduledTriageAutomationConfig = {
  automationKey: 'sentry_triage' | 'dependabot_triage' | 'ci_failure_triage';
  /**
   * Builds the scan task payload for the deployment, or skips with a logged
   * reason (missing credentials, no eligible repositories, ...).
   */
  buildScanTask: (params: {
    deployment: TriageDeploymentContext;
    channelId: string;
    runtime: AutomationRuntime;
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
): (opts?: AutomationRunOpts) => Promise<AutomationJobResult> {
  const logPrefix = `[${config.automationKey.replaceAll('_', '-')}]`;

  return async function scheduledTriageJob(
    opts: AutomationRunOpts = {},
  ): Promise<AutomationJobResult> {
    console.log(
      `${logPrefix} Starting ${config.automationKey.replaceAll('_', ' ')} evaluator`,
    );

    const now = new Date();
    const result = emptyJobResult();
    const eligibleDeployments = await findEligibleDeploymentContexts();

    if (eligibleDeployments.length === 0) {
      result.skippedReason = 'No active Slack installation.';
    }

    let processed = 0;
    let skipped = 0;

    for (const deployment of eligibleDeployments) {
      try {
        const runtime = await getAutomationRuntime(config.automationKey);
        const frequency = runtime.enabled ? runtime.scheduleMode : 'off';

        if (!frequency || frequency === 'off') {
          result.skippedReason = 'Automation is disabled.';
          skipped++;
          continue;
        }

        const channelId = runtime.slackChannelId;

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
          result.skippedReason = 'Manager channel is not configured.';
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
            lastRunAt: runtime.lastRunAt,
            scheduleHourLocal: SCHEDULE_HOUR_LOCAL,
            windowDays: WINDOW_DAYS,
          })
        ) {
          result.skippedReason = 'Not due yet.';
          skipped++;
          continue;
        }

        const scanTask = await config.buildScanTask({
          deployment,
          channelId,
          runtime,
          manualTrigger: opts.manualTrigger === true,
        });

        if (scanTask.kind === 'skip') {
          console.log(`${logPrefix} Skipping deployment: ${scanTask.reason}`);
          result.skippedReason = scanTask.reason;
          skipped++;
          continue;
        }

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

        await recordAutomationRunOutcome(db, {
          key: config.automationKey,
          status: 'succeeded',
          at: new Date(),
        });

        await postScheduledTriageRoutingDebug({
          automationKey: config.automationKey,
          slackBotToken: deployment.slackBotToken,
          manualTrigger: opts.manualTrigger === true,
          outcome: 'queued',
          taskSlackChannelId: channelId,
        });

        result.launchedTaskId ??= launchResult.taskId;
        processed++;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(message);
        await recordAutomationRunOutcome(db, {
          key: config.automationKey,
          status: 'failed',
          at: new Date(),
          error: message,
        });
        console.error(`${logPrefix} Failed deployment: ${message}`);
      }
    }

    console.log(
      `${logPrefix} Completed: ${processed} processed, ${skipped} skipped, ${result.errors.length} errors`,
    );

    if (result.errors.length > 0) {
      console.error(`${logPrefix} Errors:`, result.errors);
    }

    return result;
  };
}
