import { enqueueTask } from '@roomote/cloud-agents/server';
import {
  db,
  environments,
  eq,
  getCustomAutomationById,
  getCustomAutomationFrequency,
  listEnabledCustomAutomations,
  recordCustomAutomationRunOutcome,
  releaseCustomAutomationLaunchClaim,
  tryClaimCustomAutomationLaunch,
  type CustomAutomation,
} from '@roomote/db/server';
import {
  isConfiguredAutomationTarget,
  isBackgroundAutomationUserTargetKind,
  resolveEvalHarnessSelection,
  TaskPayloadKind,
  type AutomationTarget,
  type CommunicationProvider,
} from '@roomote/types';

import {
  buildDestinationPromptContext,
  buildDestinationTaskPayloadFields,
  findTeamsConversationServiceUrl,
  listConnectedCommunicationProviders,
  type ResolvedAutomationDestination,
} from './destination';
import {
  isCronRunDue,
  resolveDeploymentTimeZone,
  validateCronExpression,
  type ResolvedDeploymentTimeZone,
} from './custom-automation-schedule';
import { DAILY_WEEKLY_SCHEDULE_HOUR_LOCAL, isRunDue } from './scheduling-utils';
import {
  emptyJobResult,
  type AutomationJobResult,
  type AutomationRunNowResult,
  type AutomationRunOpts,
} from './types';
import { findUserDirectMessageDestination } from '../lib/user-direct-message';

const LOG_PREFIX = '[custom-automations]';

const PROVIDER_LABELS: Record<CommunicationProvider, string> = {
  discord: 'Discord',
  slack: 'Slack',
  teams: 'Teams',
  telegram: 'Telegram',
};

const WINDOW_DAYS: Record<string, number> = {
  every_hour: 1 / 24,
  every_6_hours: 6 / 24,
  daily: 1,
  weekly: 7,
};

function scheduleHourLocalForFrequency(frequency: string): number {
  if (frequency === 'daily' || frequency === 'weekly') {
    return DAILY_WEEKLY_SCHEDULE_HOUR_LOCAL;
  }

  // isRunDue always requires the local hour boundary; hour 0 means any time
  // after midnight local is eligible, so hourly windows run as soon as due.
  return 0;
}

async function resolveDestination(
  target: AutomationTarget,
): Promise<ResolvedAutomationDestination | null> {
  if (!target.provider || !target.externalRef) {
    return null;
  }

  const provider = target.provider as CommunicationProvider;
  if (
    provider !== 'slack' &&
    provider !== 'discord' &&
    provider !== 'teams' &&
    provider !== 'telegram'
  ) {
    return null;
  }

  if (isBackgroundAutomationUserTargetKind(target.targetKind)) {
    const destination = await findUserDirectMessageDestination(
      provider,
      target.externalRef,
    );
    return destination
      ? { provider, ...destination, source: 'automation_target' }
      : null;
  }

  if (provider === 'teams') {
    const metadataServiceUrl =
      typeof target.metadata?.serviceUrl === 'string'
        ? target.metadata.serviceUrl.trim()
        : '';
    const serviceUrl =
      metadataServiceUrl ||
      (await findTeamsConversationServiceUrl(target.externalRef));

    if (!serviceUrl) {
      return null;
    }

    return {
      provider,
      channelId: target.externalRef,
      source: 'automation_target',
      serviceUrl,
    };
  }

  return {
    provider,
    channelId: target.externalRef,
    source: 'automation_target',
    ...(typeof target.metadata?.serviceUrl === 'string'
      ? { serviceUrl: target.metadata.serviceUrl }
      : {}),
  };
}

/**
 * Anchors a custom automation's prompt to its configured report conversation,
 * mirroring how the built-in channel automations tell the agent which surface
 * and posting tool to report through.
 */
function buildChannelAnchoredDescription(
  prompt: string,
  destination: ResolvedAutomationDestination,
): string {
  const promptContext = buildDestinationPromptContext(destination);

  return `${prompt}

<task_context>
  <source>background-automation</source>
  <${promptContext.channelTag}>${destination.channelId}</${promptContext.channelTag}>
</task_context>

This run is anchored to the ${promptContext.surfaceLabel} conversation above and reports through \`send_chat_reply\`; do not use \`${promptContext.postToolName}\` and do not post anywhere else. Stay silent while work is in flight: send no opening acknowledgement and do not post progress updates. Send a ${promptContext.surfaceLabel} message only for your final result, a durable blocker, or a required user input. Your first message creates this run's thread in that conversation, so make it one self-contained message that stands alone for readers who have not seen this task; later messages and user replies continue that same thread. Write the report as the result itself, like a teammate sharing what they found or did: do not mention this automation, the schedule, the task, or that anything requested the work; the message footer already attributes the automation. Lead with the outcome, not with framing like "Automation requested ..." or "Outcome: ...".`;
}

async function launchCustomAutomationRow(
  automation: CustomAutomation,
  opts: AutomationRunOpts,
  scheduleContext?: ResolvedDeploymentTimeZone,
): Promise<AutomationJobResult> {
  const result = emptyJobResult();
  const frequency = getCustomAutomationFrequency(automation);

  if (automation.scheduleMode !== 'cron' && frequency === 'off') {
    result.skippedReason = 'Automation is disabled.';
    return result;
  }

  if (!opts.manualTrigger) {
    const timezone = scheduleContext ?? (await resolveDeploymentTimeZone());
    const now = new Date();
    const cronBaseline = new Date(
      Math.max(
        automation.lastRunAt?.getTime() ?? automation.createdAt.getTime(),
        timezone.updatedAt?.getTime() ?? 0,
      ),
    );
    const presetLastRunAt = timezone.updatedAt
      ? new Date(
          Math.max(
            automation.lastRunAt?.getTime() ?? 0,
            timezone.updatedAt.getTime(),
          ),
        )
      : automation.lastRunAt;
    const due =
      automation.scheduleMode === 'cron'
        ? Boolean(
            automation.cronExpression &&
            isCronRunDue({
              expression: validateCronExpression(
                automation.cronExpression,
                timezone.timeZone,
              ),
              timeZone: timezone.timeZone,
              now,
              baseline: cronBaseline,
            }),
          )
        : isRunDue({
            now,
            timeZone: timezone.timeZone,
            frequency,
            lastRunAt: presetLastRunAt,
            scheduleHourLocal: scheduleHourLocalForFrequency(frequency),
            windowDays: WINDOW_DAYS,
          });

    if (!due) {
      result.skippedReason = 'Not due yet.';
      return result;
    }
  }

  if (!automation.environmentId) {
    result.skippedReason = 'Environment is not configured.';
    result.errors.push('Environment is not configured.');
    await recordCustomAutomationRunOutcome(db, {
      id: automation.id,
      status: 'failed',
      error: 'Environment is not configured.',
    });
    return result;
  }

  const environment = await db.query.environments.findFirst({
    columns: { id: true },
    where: eq(environments.id, automation.environmentId),
  });

  if (!environment) {
    result.skippedReason = 'Environment no longer exists.';
    result.errors.push('Environment no longer exists.');
    await recordCustomAutomationRunOutcome(db, {
      id: automation.id,
      status: 'failed',
      error: 'Environment no longer exists.',
    });
    return result;
  }

  // A report destination is optional: automations without one run silently
  // and surface results only in the task UI.
  let destination: ResolvedAutomationDestination | null = null;
  if (isConfiguredAutomationTarget(automation.target)) {
    destination = await resolveDestination(automation.target);
    if (!destination) {
      const message = isBackgroundAutomationUserTargetKind(
        automation.target.targetKind,
      )
        ? `The automation owner does not have a linked ${PROVIDER_LABELS[automation.target.provider as CommunicationProvider]} account that can receive direct messages.`
        : automation.target.provider === 'teams'
          ? 'Teams report destination is missing a resolvable service URL.'
          : 'Report destination could not be resolved.';
      result.skippedReason = message;
      result.errors.push(message);
      await recordCustomAutomationRunOutcome(db, {
        id: automation.id,
        status: 'failed',
        error: message,
      });
      return result;
    }

    const connected = await listConnectedCommunicationProviders();
    if (!connected.includes(destination.provider)) {
      const message = `${destination.provider} is not connected.`;
      result.skippedReason = message;
      result.errors.push(message);
      await recordCustomAutomationRunOutcome(db, {
        id: automation.id,
        status: 'failed',
        error: message,
      });
      return result;
    }
  }

  // The short claim fence prevents concurrent launchers from double-launching
  // without blocking a due run behind a previous task that still appears active.
  const launchClaimedAt = await tryClaimCustomAutomationLaunch(
    automation.id,
    automation.lastRunAt,
  );
  if (!launchClaimedAt) {
    result.skippedReason = 'Another launch is already in progress.';
    return result;
  }

  // A persisted model override is validated on save; a value that no longer
  // parses is ignored so a stale pin degrades to the deployment default
  // instead of blocking the scheduled run.
  const modelSelection = automation.model
    ? resolveEvalHarnessSelection({ model: automation.model })
    : null;
  if (modelSelection && !modelSelection.ok) {
    console.warn(
      `${LOG_PREFIX} Ignoring invalid model override "${automation.model}" on automation ${automation.id}: ${modelSelection.error}`,
    );
  }
  const modelOverride = modelSelection?.ok ? modelSelection : null;

  try {
    const launchResult = await enqueueTask({
      task: {
        type: TaskPayloadKind.StandardTask,
        ...(modelOverride?.harness ? { harness: modelOverride.harness } : {}),
        payload: {
          repo: '',
          environmentId: automation.environmentId,
          description: destination
            ? buildChannelAnchoredDescription(automation.prompt, destination)
            : automation.prompt,
          ...(destination
            ? buildDestinationTaskPayloadFields(destination)
            : {}),
          // customAutomationId authorizes the Slack late-bound thread flow:
          // the run's first send_chat_reply posts a root message in the
          // destination channel and binds it as the task thread, so later
          // updates continue the thread and user replies route back into the
          // task. The channel/slackChannel payload fields give the sandbox
          // its Slack reply context (ROOMOTE_SLACK_CHANNEL).
          ...(destination ? { customAutomationId: automation.id } : {}),
          ...(destination?.provider === 'slack'
            ? {
                channel: destination.channelId,
                slackChannel: destination.channelId,
                ...(destination.teamId
                  ? {
                      teamId: destination.teamId,
                      slackTeamId: destination.teamId,
                    }
                  : {}),
              }
            : {}),
          ...(modelOverride?.harnessModelOverrides
            ? { harnessModelOverrides: modelOverride.harnessModelOverrides }
            : {}),
        },
      },
      title: automation.name,
      initiator: {
        kind: 'automation',
        key: 'custom_automation',
        actor: {
          externalId: automation.id,
          displayName: automation.name,
        },
      },
      workflow: 'standard',
      surface: 'system',
      trigger: opts.manualTrigger ? 'manual' : 'schedule',
      ...(destination?.provider === 'slack'
        ? { channels: { slackChannelId: destination.channelId } }
        : {}),
    });

    await recordCustomAutomationRunOutcome(db, {
      id: automation.id,
      status: 'succeeded',
      lastLaunchedTaskId: launchResult.taskId,
      launchClaimedAt,
    });

    result.launchedTaskId = launchResult.taskId;
    result.completed = true;
    return result;
  } catch (error) {
    await releaseCustomAutomationLaunchClaim(automation.id, launchClaimedAt);
    throw error;
  }
}

export async function customAutomationsJob(
  opts: AutomationRunOpts = {},
): Promise<AutomationJobResult> {
  console.log(`${LOG_PREFIX} Starting custom automations evaluator`);

  const result = emptyJobResult();
  const rows = await listEnabledCustomAutomations();

  if (rows.length === 0) {
    result.skippedReason = 'No enabled custom automations.';
    return result;
  }

  const scheduleContext = await resolveDeploymentTimeZone();
  let processed = 0;
  let skipped = 0;

  for (const automation of rows) {
    try {
      const rowResult = await launchCustomAutomationRow(
        automation,
        opts,
        scheduleContext,
      );

      if (rowResult.launchedTaskId) {
        result.launchedTaskId ??= rowResult.launchedTaskId;
        processed++;
      } else if (rowResult.errors.length > 0) {
        result.errors.push(
          ...rowResult.errors.map((e) => `${automation.name}: ${e}`),
        );
        skipped++;
      } else {
        skipped++;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(`${automation.name}: ${message}`);
      await recordCustomAutomationRunOutcome(db, {
        id: automation.id,
        status: 'failed',
        error: message,
      });
      console.error(`${LOG_PREFIX} Failed ${automation.id}: ${message}`);
    }
  }

  console.log(
    `${LOG_PREFIX} Completed: ${processed} launched, ${skipped} skipped, ${result.errors.length} errors`,
  );

  return result;
}

export async function runCustomAutomationNow(
  id: string,
): Promise<AutomationRunNowResult> {
  const automation = await getCustomAutomationById(id);

  if (!automation) {
    return { outcome: 'failed', error: 'Custom automation was not found.' };
  }

  if (!automation.enabled) {
    return {
      outcome: 'failed',
      error:
        'This custom automation is disabled. Enable and save it before running.',
    };
  }

  try {
    const result = await launchCustomAutomationRow(automation, {
      manualTrigger: true,
    });

    if (result.launchedTaskId) {
      return { outcome: 'launched', taskId: result.launchedTaskId };
    }

    if (result.errors.length > 0) {
      return { outcome: 'failed', error: result.errors.join('; ') };
    }

    if (result.skippedReason) {
      return { outcome: 'skipped', reason: result.skippedReason };
    }

    if (result.completed) {
      return { outcome: 'completed' };
    }

    return { outcome: 'skipped', reason: 'Nothing to do.' };
  } catch (error) {
    return {
      outcome: 'failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
