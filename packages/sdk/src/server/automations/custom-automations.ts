import { enqueueTask } from '@roomote/cloud-agents/server';
import {
  db,
  environments,
  eq,
  getCustomAutomationById,
  getCustomAutomationFrequency,
  isCustomAutomationPreviousRunActive,
  listEnabledCustomAutomations,
  recordCustomAutomationRunOutcome,
  slackInstallations,
  type CustomAutomation,
} from '@roomote/db/server';
import {
  TaskPayloadKind,
  type AutomationTarget,
  type CommunicationProvider,
} from '@roomote/types';

import {
  buildDestinationTaskPayloadFields,
  listConnectedCommunicationProviders,
  type ResolvedAutomationDestination,
} from './destination';
import { isRunDue, resolveSlackWorkspaceTimezone } from './scheduling-utils';
import {
  emptyJobResult,
  type AutomationJobResult,
  type AutomationRunNowResult,
  type AutomationRunOpts,
} from './types';

const LOG_PREFIX = '[custom-automations]';
const SCHEDULE_HOUR_LOCAL = 3;

const WINDOW_DAYS: Record<string, number> = {
  every_hour: 1 / 24,
  every_6_hours: 6 / 24,
  daily: 1,
  weekly: 7,
};

function targetToDestination(
  target: AutomationTarget,
): ResolvedAutomationDestination | null {
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

  return {
    provider,
    channelId: target.externalRef,
    source: 'automation_target',
    ...(typeof target.metadata?.serviceUrl === 'string'
      ? { serviceUrl: target.metadata.serviceUrl }
      : {}),
  };
}

async function resolveTimezone(): Promise<string> {
  const installation = await db.query.slackInstallations.findFirst({
    columns: { botAccessToken: true, teamId: true },
    where: eq(slackInstallations.isActive, true),
  });

  if (!installation?.botAccessToken || !installation.teamId) {
    return 'UTC';
  }

  return resolveSlackWorkspaceTimezone(
    {
      slackBotToken: installation.botAccessToken,
      slackTeamId: installation.teamId,
    },
    LOG_PREFIX,
  );
}

async function launchCustomAutomationRow(
  automation: CustomAutomation,
  opts: AutomationRunOpts,
): Promise<AutomationJobResult> {
  const result = emptyJobResult();
  const frequency = getCustomAutomationFrequency(automation);

  if (frequency === 'off') {
    result.skippedReason = 'Automation is disabled.';
    return result;
  }

  if (!opts.manualTrigger) {
    const timezone = await resolveTimezone();
    const now = new Date();

    if (
      !isRunDue({
        now,
        timeZone: timezone,
        frequency,
        lastRunAt: automation.lastRunAt,
        scheduleHourLocal: SCHEDULE_HOUR_LOCAL,
        windowDays: WINDOW_DAYS,
      })
    ) {
      result.skippedReason = 'Not due yet.';
      return result;
    }
  }

  if (await isCustomAutomationPreviousRunActive(automation)) {
    result.skippedReason = 'Previous run is still active.';
    return result;
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

  const destination = targetToDestination(automation.target);
  if (!destination) {
    result.skippedReason = 'Report destination is not configured.';
    result.errors.push('Report destination is not configured.');
    await recordCustomAutomationRunOutcome(db, {
      id: automation.id,
      status: 'failed',
      error: 'Report destination is not configured.',
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

  const launchResult = await enqueueTask({
    task: {
      type: TaskPayloadKind.StandardTask,
      payload: {
        repo: '',
        environmentId: automation.environmentId,
        description: automation.prompt,
        ...buildDestinationTaskPayloadFields(destination),
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
    ...(destination.provider === 'slack'
      ? { channels: { slackChannelId: destination.channelId } }
      : {}),
  });

  await recordCustomAutomationRunOutcome(db, {
    id: automation.id,
    status: 'succeeded',
    lastLaunchedTaskId: launchResult.taskId,
  });

  result.launchedTaskId = launchResult.taskId;
  result.completed = true;
  return result;
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

  let processed = 0;
  let skipped = 0;

  for (const automation of rows) {
    try {
      const rowResult = await launchCustomAutomationRow(automation, opts);

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
