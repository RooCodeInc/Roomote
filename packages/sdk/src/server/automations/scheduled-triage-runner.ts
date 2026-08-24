import { randomUUID } from 'node:crypto';

import { enqueueTask } from '@roomote/cloud-agents/server';
import {
  db,
  eq,
  getAutomationRuntime,
  recordAutomationRunOutcome,
  slackInstallations,
  type AutomationRuntime,
} from '@roomote/db/server';
import {
  TaskPayloadKind,
  type FastAutomationExecutionPolicy,
  type SuggestedTasksTask,
} from '@roomote/types';

import {
  buildDestinationTaskPayloadFields,
  listConnectedCommunicationProviders,
  resolveAutomationRuntimeDestination,
  type ResolvedAutomationDestination,
} from './destination';
import { resolveDeploymentTimeZone } from './custom-automation-schedule';
import { isRunDue } from './scheduling-utils';
import { postScheduledTriageRoutingDebug } from './triage-routing-debug';
import {
  buildScheduledAutomationOccurrenceKey,
  executeFastBuiltInAutomation,
  recordFastBuiltInAutomationPreflightFailure,
} from './fast-automation-runner';
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
  fastPolicy?: FastAutomationExecutionPolicy;
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
      let failureRuntime: AutomationRuntime | null = null;
      let failureDestination: ResolvedAutomationDestination | null = null;
      let failureFrequency = 'unknown';
      let failureTimeZone = 'UTC';
      let fastExecutionStarted = false;
      const manualOccurrenceKey = opts.manualTrigger
        ? `manual:${randomUUID()}`
        : null;
      try {
        const runtime = await getAutomationRuntime(config.automationKey);
        const frequency = runtime.enabled ? runtime.scheduleMode : 'off';
        failureRuntime = runtime;
        failureFrequency = frequency ?? 'off';

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
        failureDestination = destination;

        if (!destination) {
          if (deployment.slackBotToken) {
            await postScheduledTriageRoutingDebug({
              automationKey: config.automationKey,
              slackBotToken: deployment.slackBotToken,
              manualTrigger: opts.manualTrigger === true,
              outcome: 'skipped',
              taskSlackChannelId: null,
              details:
                'Manager channel not configured, so the task was not queued.',
            });
          }
          console.log(
            `${logPrefix} Skipping deployment: manager channel not configured`,
          );
          result.skippedReason = 'Manager channel is not configured.';
          skipped++;
          continue;
        }

        const channelId = destination.channelId;
        const timezone = (await resolveDeploymentTimeZone()).timeZone;
        failureTimeZone = timezone;

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
          if (
            runtime.executionRoute === 'fast' &&
            config.fastPolicy &&
            config.automationKey === 'sentry_triage' &&
            scanTask.reason === 'Sentry MCP is not configured'
          ) {
            await recordFastBuiltInAutomationPreflightFailure({
              automationKey: config.automationKey,
              triggerKind: opts.manualTrigger ? 'manual' : 'schedule',
              occurrenceKey:
                manualOccurrenceKey ??
                buildScheduledAutomationOccurrenceKey({
                  automationKey: config.automationKey,
                  frequency,
                  now,
                  timeZone: timezone,
                  partition: `${destination.provider}:${channelId}:0`,
                }),
              policy: {
                ...config.fastPolicy,
                allowedEnvironmentIds: [],
              },
              destination,
              error: scanTask.reason,
              reportMessage:
                'Sentry triage could not run because the deployment Sentry integration is not configured.',
            });
            result.errors.push(scanTask.reason);
            skipped++;
            continue;
          }
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
        const fastRoute =
          runtime.executionRoute === 'fast' && Boolean(config.fastPolicy);

        if (fastRoute) {
          for (const [index, payload] of scanTask.payloads.entries()) {
            if (!payload.description) {
              throw new Error('Fast triage payload is missing its prompt.');
            }
            fastExecutionStarted = true;
            await executeFastBuiltInAutomation({
              automationKey: config.automationKey,
              triggerKind: opts.manualTrigger ? 'manual' : 'schedule',
              occurrenceKey: opts.manualTrigger
                ? manualOccurrenceKey!
                : buildScheduledAutomationOccurrenceKey({
                    automationKey: config.automationKey,
                    frequency,
                    now,
                    timeZone: timezone,
                    partition: `${destination.provider}:${channelId}:${index}`,
                  }),
              prompt: payload.description,
              policy: {
                ...config.fastPolicy!,
                allowedEnvironmentIds:
                  payload.fastAutomationAllowedEnvironmentIds ?? [],
              },
              destination,
            });
          }
          result.completed = true;
        } else {
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
        }

        if (deployment.slackBotToken) {
          await postScheduledTriageRoutingDebug({
            automationKey: config.automationKey,
            slackBotToken: deployment.slackBotToken,
            manualTrigger: opts.manualTrigger === true,
            outcome: 'queued',
            taskSlackChannelId:
              destination.provider === 'slack' ? channelId : null,
            ...(destination.provider === 'slack'
              ? {}
              : {
                  details: `Task reports to the ${destination.provider} conversation ${channelId}.`,
                }),
          });
        }

        result.launchedTaskId ??= firstLaunchedTaskId;
        processed++;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(message);
        if (
          config.fastPolicy &&
          failureRuntime?.executionRoute === 'fast' &&
          !fastExecutionStarted
        ) {
          await recordFastBuiltInAutomationPreflightFailure({
            automationKey: config.automationKey,
            triggerKind: opts.manualTrigger ? 'manual' : 'schedule',
            occurrenceKey:
              manualOccurrenceKey ??
              buildScheduledAutomationOccurrenceKey({
                automationKey: config.automationKey,
                frequency: failureFrequency,
                now,
                timeZone: failureTimeZone,
                partition: `${failureDestination?.provider ?? 'unresolved'}:${failureDestination?.channelId ?? 'unresolved'}`,
              }),
            policy: {
              ...config.fastPolicy,
              allowedEnvironmentIds: [],
            },
            destination: failureDestination,
            error: message,
          });
        }
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
