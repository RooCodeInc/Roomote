import { SlackNotifier } from '@roomote/slack';

import { getRedis } from '@roomote/redis';

export interface SlackDeploymentContext {
  slackBotToken: string;
  slackTeamId: string;
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
