import { CronExpressionParser } from 'cron-parser';
import { z } from 'zod';

import {
  generateTrackedNonTaskObject,
  NON_TASK_INFERENCE_SURFACES,
} from '@roomote/cloud-agents/server';
import {
  db,
  deploymentSettings,
  eq,
  slackInstallations,
} from '@roomote/db/server';
import { CUSTOM_AUTOMATION_CRON_MAX_LENGTH } from '@roomote/types';

import {
  DAILY_WEEKLY_SCHEDULE_HOUR_LOCAL,
  resolveSlackWorkspaceTimezone,
} from './scheduling-utils';
import {
  customAutomationValidationError,
  CustomAutomationWriteError,
} from './custom-automation-errors';

const DEFAULT_DEPLOYMENT_SETTINGS_ID = 'default';
const LOG_PREFIX = '[custom-automation-schedule]';

export type DeploymentTimeZoneSource = 'explicit' | 'slack' | 'utc_fallback';

export type ResolvedDeploymentTimeZone = {
  timeZone: string;
  source: DeploymentTimeZoneSource;
  updatedAt: Date | null;
};

export function normalizeTimeZone(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw customAutomationValidationError('Timezone is required.');
  }

  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: trimmed,
    }).resolvedOptions().timeZone;
  } catch {
    throw customAutomationValidationError('Choose a valid IANA timezone.');
  }
}

export async function resolveDeploymentTimeZone(): Promise<ResolvedDeploymentTimeZone> {
  const settings = await db.query.deploymentSettings.findFirst({
    where: eq(deploymentSettings.id, DEFAULT_DEPLOYMENT_SETTINGS_ID),
    columns: { timeZone: true, timeZoneUpdatedAt: true },
  });

  if (settings?.timeZone) {
    return {
      timeZone: normalizeTimeZone(settings.timeZone),
      source: 'explicit',
      updatedAt: settings.timeZoneUpdatedAt,
    };
  }

  const installation = await db.query.slackInstallations.findFirst({
    columns: { botAccessToken: true, teamId: true },
    where: eq(slackInstallations.isActive, true),
  });
  if (installation?.botAccessToken && installation.teamId) {
    const timeZone = await resolveSlackWorkspaceTimezone(
      {
        slackBotToken: installation.botAccessToken,
        slackTeamId: installation.teamId,
      },
      LOG_PREFIX,
    );
    return {
      timeZone,
      source: timeZone === 'UTC' ? 'utc_fallback' : 'slack',
      updatedAt: null,
    };
  }

  return { timeZone: 'UTC', source: 'utc_fallback', updatedAt: null };
}

export function validateCronExpression(
  value: string,
  timeZone: string,
): string {
  const expression = value.trim().replace(/\s+/g, ' ');
  if (!expression || expression.length > CUSTOM_AUTOMATION_CRON_MAX_LENGTH) {
    throw customAutomationValidationError(
      `Cron expression must be between 1 and ${CUSTOM_AUTOMATION_CRON_MAX_LENGTH} characters.`,
    );
  }
  if (expression.split(' ').length !== 5) {
    throw customAutomationValidationError(
      'Use a standard five-field cron expression.',
    );
  }

  try {
    CronExpressionParser.parse(expression, { tz: normalizeTimeZone(timeZone) });
  } catch (error) {
    if (error instanceof CustomAutomationWriteError) throw error;
    throw customAutomationValidationError(
      'Use a valid standard five-field cron expression.',
      { cause: error },
    );
  }
  return expression;
}

export function getCronOccurrence(
  expression: string,
  timeZone: string,
  direction: 'previous' | 'next',
  now = new Date(),
): Date {
  const interval = CronExpressionParser.parse(
    validateCronExpression(expression, timeZone),
    {
      currentDate: now,
      tz: timeZone,
    },
  );
  return (
    direction === 'previous' ? interval.prev() : interval.next()
  ).toDate();
}

export function isCronRunDue(params: {
  expression: string;
  timeZone: string;
  now: Date;
  baseline: Date;
}): boolean {
  return (
    getCronOccurrence(
      params.expression,
      params.timeZone,
      'previous',
      params.now,
    ).getTime() > params.baseline.getTime()
  );
}

const scheduleResolutionSchema = z
  .object({
    status: z.enum(['resolved', 'ambiguous']),
    cronExpression: z.string().nullable(),
    summary: z.string().trim().min(1),
    clarification: z.string().trim().nullable(),
  })
  .strict();

export type CustomAutomationScheduleResolution = {
  status: 'resolved' | 'ambiguous';
  cronExpression: string | null;
  summary: string;
  clarification: string | null;
  timeZone: string;
  nextRunAt: Date | null;
};

export async function resolveCustomAutomationSchedule(params: {
  schedule: string;
  userId?: string | null;
  now?: Date;
}): Promise<CustomAutomationScheduleResolution> {
  const now = params.now ?? new Date();
  const { timeZone } = await resolveDeploymentTimeZone();

  try {
    const cronExpression = validateCronExpression(params.schedule, timeZone);
    return {
      status: 'resolved',
      cronExpression,
      summary: `Runs on ${cronExpression}`,
      clarification: null,
      timeZone,
      nextRunAt: getCronOccurrence(cronExpression, timeZone, 'next', now),
    };
  } catch {
    // Non-cron input is interpreted below. Generated cron is validated again.
  }

  const { object } = await generateTrackedNonTaskObject({
    surface: NON_TASK_INFERENCE_SURFACES.customAutomationScheduleResolution,
    userId: params.userId,
    schema: scheduleResolutionSchema,
    maxOutputTokens: 300,
    system: `Convert a recurring schedule into standard five-field cron. The timezone is ${timeZone} and the reference time is ${now.toISOString()}. Never use seconds or cron macros. When the input names a clear recurrence but omits the time of day, use ${DAILY_WEEKLY_SCHEDULE_HOUR_LOCAL}:00 and note the default time in the summary. Never resolve conflicting instructions. When the recurrence itself is unclear or instructions conflict, return status "ambiguous", cronExpression null, and one focused clarification question. For clear input, return status "resolved", a five-field cron expression, a concise plain-English summary, and clarification null.`,
    prompt: params.schedule,
  });

  if (object.status === 'ambiguous' || !object.cronExpression) {
    return {
      status: 'ambiguous',
      cronExpression: null,
      summary: object.summary,
      clarification: object.clarification ?? 'What time should this run?',
      timeZone,
      nextRunAt: null,
    };
  }

  const cronExpression = validateCronExpression(
    object.cronExpression,
    timeZone,
  );
  return {
    status: 'resolved',
    cronExpression,
    summary: object.summary,
    clarification: null,
    timeZone,
    nextRunAt: getCronOccurrence(cronExpression, timeZone, 'next', now),
  };
}
