import { enqueueTask } from '@roomote/cloud-agents/server';
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
  buildDestinationTaskPayloadFields,
  listConnectedCommunicationProviders,
  resolveAutomationRuntimeDestination,
  type ResolvedAutomationDestination,
} from './destination';
import { resolveDeploymentTimeZone } from './custom-automation-schedule';
import { isRunDue } from './scheduling-utils';
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

type TriageDeploymentContext = {
  slackBotToken: string | null;
  slackTeamId: string | null;
};

export type TriageScanBuild =
  /**
   * One task run launches per payload. Builders whose repository scope can
   * span source-control providers must return one payload per provider so
   * every launched run stays single-provider (a run's source-control token
   * is minted for exactly one provider).
   */
  | { kind: 'scan'; payloads: SuggestedTasksTask['payload'][] }
  | { kind: 'skip'; reason: string };

type ScheduledTriageAutomationConfig = {
  automationKey:
    | 'sentry_triage'
    | 'dependabot_triage'
    | 'codeql_triage'
    | 'ci_failure_triage';

  /**
   * Builds the scan task payload for the deployment, or skips with a logged
   * reason (missing credentials, no eligible repositories, ...).
   */
  buildScanTask: (params: {
    deployment: TriageDeploymentContext;
    channelId: string;
    destination: ResolvedAutomationDestination;
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

  if (rows.length > 0) {
    return rows.map((installation) => ({
      slackBotToken: installation.botAccessToken,
      slackTeamId: installation.teamId,
    }));
  }

  // No Slack: the deployment is still eligible when another comms provider
  // can carry the automation's reports.
  const connectedProviders = await listConnectedCommunicationProviders();

  return connectedProviders.length > 0
    ? [{ slackBotToken: null, slackTeamId: null }]
    : [];
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
      result.skippedReason = 'No connected communication provider.';
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

        const destination =
          opts.destination ??
          (await resolveAutomationRuntimeDestination({
            runtime,
            slackConnected: deployment.slackBotToken !== null,
          }));

        if (!destination) {
          console.log(
            `${logPrefix} Skipping deployment: manager channel not configured`,
          );
          result.skippedReason = 'Manager channel is not configured.';
          skipped++;
          continue;
        }

        const channelId = destination.channelId;
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

        const scanTask = await config.buildScanTask({
          deployment,
          channelId,
          destination,
          runtime,
          manualTrigger: opts.manualTrigger === true,
        });

        if (scanTask.kind === 'skip') {
          console.log(`${logPrefix} Skipping deployment: ${scanTask.reason}`);
          result.skippedReason = scanTask.reason;
          skipped++;
          continue;
        }

        if (scanTask.payloads.length === 0) {
          console.log(
            `${logPrefix} Skipping deployment: builder returned no scan payloads`,
          );
          result.skippedReason = 'No scan payloads to launch.';
          skipped++;
          continue;
        }

        // Automation scans run as the deployment service principal; a manual
        // trigger is still an automation launch, just with a manual trigger
        // kind on the task record. Non-Slack destinations ride along as
        // communication payload fields so the surface-generic worker tools
        // target the destination conversation. Multi-provider builders return
        // one payload per provider partition; each launches its own run.
        let firstLaunchedTaskId: string | null = null;

        for (const payload of scanTask.payloads) {
          const launchResult = await enqueueTask({
            task: {
              type: TaskPayloadKind.Scan,
              payload: {
                ...payload,
                ...buildDestinationTaskPayloadFields(destination),
              },
            },
            initiator: { kind: 'automation', key: config.automationKey },
            workflow: 'scan',
            surface: 'system',
            trigger: opts.manualTrigger ? 'manual' : 'schedule',
            visibility: 'hidden',
            ...(destination.provider === 'slack'
              ? { channels: { slackChannelId: channelId } }
              : {}),
          });

          firstLaunchedTaskId ??= launchResult.taskId;
        }

        await recordAutomationRunOutcome(db, {
          key: config.automationKey,
          status: 'succeeded',
          at: new Date(),
        });

        result.launchedTaskId ??= firstLaunchedTaskId;
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
