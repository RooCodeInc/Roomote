import { SlackNotifier } from '@roomote/slack';
import { CronExpressionParser } from 'cron-parser';

import { getRedis } from '@roomote/redis';

interface SlackDeploymentContext {
  slackBotToken: string;
  slackTeamId: string;
}

/**
 * Local hour used when a schedule specifies a day but no time: daily/weekly
 * preset due-gating and the default time for natural-language custom
 * schedules that omit a time of day.
 */
export const DAILY_WEEKLY_SCHEDULE_HOUR_LOCAL = 3;

const MANAGER_STATS_SCHEDULES = {
  daily: '0 17 * * *',
  weekly: '0 17 * * 5',
  monthly: '0 17 L * *',
} as const;

type ManagerStatsScheduleFrequency = keyof typeof MANAGER_STATS_SCHEDULES;

/**
 * Manager Stats ends its configured calendar period at 5 PM local time. The
 * scheduler still ticks hourly, but the due boundary is calculated from a
 * timezone-aware cron occurrence so DST and month length are not approximated
 * with elapsed milliseconds.
 */
export function isManagerStatsRunDueOnLocalPeriod(params: {
  now: Date;
  timeZone: string;
  lastRunAt: Date | null;
  frequency: ManagerStatsScheduleFrequency;
}): boolean {
  const localDate = getLocalDateParts(params.now, params.timeZone);
  const { hour, minute } = getLocalHourMinute(params.now, params.timeZone);
  const afterFivePm = hour > 17 || (hour === 17 && minute >= 0);
  const localDayOfWeek = getLocalDayOfWeek(params.now, params.timeZone);
  const lastDayOfMonth = new Date(
    Date.UTC(localDate.year, localDate.month, 0),
  ).getUTCDate();
  const atPeriodEnd =
    params.frequency === 'daily'
      ? afterFivePm
      : params.frequency === 'weekly'
        ? localDayOfWeek === 5 && afterFivePm
        : localDate.day === lastDayOfMonth && afterFivePm;

  if (!atPeriodEnd) return false;

  const occurrence = CronExpressionParser.parse(
    MANAGER_STATS_SCHEDULES[params.frequency],
    {
      currentDate: new Date(params.now.getTime() + 1),
      tz: params.timeZone,
    },
  )
    .prev()
    .toDate();

  return (
    occurrence.getTime() <= params.now.getTime() &&
    (!params.lastRunAt || params.lastRunAt.getTime() < occurrence.getTime())
  );
}

function getLocalDateKey(date: Date, timeZone: string): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });

  return formatter.format(date);
}

function getLocalDayOfWeek(date: Date, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
  });
  const weekday = formatter.format(date);
  const dayByWeekday = new Map([
    ['Sun', 0],
    ['Mon', 1],
    ['Tue', 2],
    ['Wed', 3],
    ['Thu', 4],
    ['Fri', 5],
    ['Sat', 6],
  ]);

  return dayByWeekday.get(weekday) ?? -1;
}

function getLocalDateParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  return { year: value('year'), month: value('month'), day: value('day') };
}

function getLocalHourMinute(
  date: Date,
  timeZone: string,
): {
  hour: number;
  minute: number;
} {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  });
  const parts = formatter.formatToParts(date);
  const hourPart = parts.find((part) => part.type === 'hour')?.value ?? '0';
  const minutePart = parts.find((part) => part.type === 'minute')?.value ?? '0';

  return {
    hour: Number.parseInt(hourPart, 10),
    minute: Number.parseInt(minutePart, 10),
  };
}

function hasReachedLocalRunBoundary(
  now: Date,
  timeZone: string,
  scheduleHourLocal: number,
): boolean {
  const { hour, minute } = getLocalHourMinute(now, timeZone);

  return (
    hour > scheduleHourLocal || (hour === scheduleHourLocal && minute >= 0)
  );
}

export function isWeeklyRunDueOnLocalDay({
  now,
  timeZone,
  lastRunAt,
  scheduleDayLocal,
  scheduleHourLocal,
}: {
  now: Date;
  timeZone: string;
  lastRunAt: Date | null;
  scheduleDayLocal: number;
  scheduleHourLocal: number;
}): boolean {
  if (getLocalDayOfWeek(now, timeZone) !== scheduleDayLocal) {
    return false;
  }

  if (!hasReachedLocalRunBoundary(now, timeZone, scheduleHourLocal)) {
    return false;
  }

  if (!lastRunAt) {
    return true;
  }

  return (
    getLocalDateKey(lastRunAt, timeZone) !== getLocalDateKey(now, timeZone)
  );
}

export function isRunDue<TFrequency extends string>({
  now,
  timeZone,
  frequency,
  lastRunAt,
  scheduleHourLocal,
  windowDays,
}: {
  now: Date;
  timeZone: string;
  frequency: TFrequency;
  lastRunAt: Date | null;
  scheduleHourLocal: number;
  windowDays: Record<TFrequency, number>;
}): boolean {
  if (!hasReachedLocalRunBoundary(now, timeZone, scheduleHourLocal)) {
    return false;
  }

  if (!lastRunAt) {
    return true;
  }

  if (frequency === 'daily') {
    return (
      getLocalDateKey(lastRunAt, timeZone) !== getLocalDateKey(now, timeZone)
    );
  }

  return (
    now.getTime() - lastRunAt.getTime() >=
    windowDays[frequency] * 24 * 60 * 60 * 1000
  );
}

export async function resolveSlackWorkspaceTimezone(
  context: SlackDeploymentContext,
  logPrefix: string,
): Promise<string> {
  const redis = getRedis();
  const key = `background-agents:timezone:${context.slackTeamId}`;

  const cached = await redis.get(key);
  if (cached && cached.trim()) {
    return cached;
  }

  const notifier = new SlackNotifier(context.slackBotToken);
  const timezone = await notifier.getWorkspaceTimezone();
  const resolved = timezone || 'UTC';

  if (!timezone) {
    console.warn(
      `${logPrefix} Slack workspace timezone unavailable; falling back to UTC`,
    );
  }

  await redis.set(key, resolved, 'EX', 24 * 60 * 60);

  return resolved;
}
