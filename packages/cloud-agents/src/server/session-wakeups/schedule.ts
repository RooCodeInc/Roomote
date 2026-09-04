import { CronExpressionParser } from 'cron-parser';

import {
  SESSION_WAKEUP_MAX_INTERVAL_MINUTES,
  SESSION_WAKEUP_MAX_ONCE_HORIZON_MINUTES,
  SESSION_WAKEUP_MIN_INTERVAL_MINUTES,
  SESSION_WAKEUP_UNCAPPED_MIN_INTERVAL_MINUTES,
  type SessionWakeupSchedule,
  type SessionWakeupScheduleInput,
} from '@roomote/types';

const MINUTE_MS = 60_000;

/** A schedule or option the agent supplied that cannot be honoured. */
export class SessionWakeupValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionWakeupValidationError';
  }
}

export function normalizeSessionWakeupTimeZone(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new SessionWakeupValidationError('Timezone is required.');
  }
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: trimmed,
    }).resolvedOptions().timeZone;
  } catch {
    throw new SessionWakeupValidationError(
      `"${trimmed}" is not a valid IANA timezone.`,
    );
  }
}

function parseIsoDate(value: string, field: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new SessionWakeupValidationError(
      `${field} must be an ISO 8601 date-time.`,
    );
  }
  return parsed;
}

function nextCronOccurrence(
  expression: string,
  timeZone: string,
  from: Date,
): Date {
  const interval = CronExpressionParser.parse(expression, {
    currentDate: from,
    tz: timeZone,
  });
  return interval.next().toDate();
}

export type NormalizedSessionWakeupSchedule = {
  schedule: SessionWakeupSchedule;
  firstRunAt: Date;
};

/**
 * Validate the agent-supplied schedule and resolve its first occurrence.
 * Relative delays are resolved against `now`; cron expressions default to
 * the deployment timezone.
 */
export function normalizeSessionWakeupSchedule(
  input: SessionWakeupScheduleInput,
  options: { now: Date; defaultTimeZone: string },
): NormalizedSessionWakeupSchedule {
  const { now } = options;
  switch (input.mode) {
    case 'once': {
      // Models often send a computed `at` alongside `inMinutes`; the relative
      // form is authoritative because it cannot be off by a clock skew.
      const hasDelay = input.inMinutes !== undefined;
      const hasAt = input.at !== undefined;
      if (!hasDelay && !hasAt) {
        throw new SessionWakeupValidationError(
          'A once schedule needs inMinutes or at.',
        );
      }
      const at = hasDelay
        ? new Date(now.getTime() + input.inMinutes! * MINUTE_MS)
        : parseIsoDate(input.at!, 'at');
      if (at.getTime() <= now.getTime()) {
        throw new SessionWakeupValidationError(
          `at must be in the future. The current time is ${now.toISOString()}.`,
        );
      }
      if (
        at.getTime() - now.getTime() >
        SESSION_WAKEUP_MAX_ONCE_HORIZON_MINUTES * MINUTE_MS
      ) {
        throw new SessionWakeupValidationError(
          'A once schedule may be at most 30 days out.',
        );
      }
      return {
        schedule: { mode: 'once', at: at.toISOString() },
        firstRunAt: at,
      };
    }
    case 'interval': {
      if (
        !Number.isInteger(input.everyMinutes) ||
        input.everyMinutes < SESSION_WAKEUP_MIN_INTERVAL_MINUTES ||
        input.everyMinutes > SESSION_WAKEUP_MAX_INTERVAL_MINUTES
      ) {
        throw new SessionWakeupValidationError(
          `everyMinutes must be a whole number between ${SESSION_WAKEUP_MIN_INTERVAL_MINUTES} and ${SESSION_WAKEUP_MAX_INTERVAL_MINUTES}.`,
        );
      }
      return {
        schedule: { mode: 'interval', everyMinutes: input.everyMinutes },
        firstRunAt: new Date(now.getTime() + input.everyMinutes * MINUTE_MS),
      };
    }
    case 'cron': {
      const timezone = normalizeSessionWakeupTimeZone(
        input.timezone ?? options.defaultTimeZone,
      );
      const expression = input.expression.trim().replace(/\s+/g, ' ');
      if (expression.split(' ').length !== 5) {
        throw new SessionWakeupValidationError(
          'Use a standard five-field cron expression.',
        );
      }
      let firstRunAt: Date;
      try {
        firstRunAt = nextCronOccurrence(expression, timezone, now);
      } catch (error) {
        throw new SessionWakeupValidationError(
          `Invalid cron expression "${expression}": ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return {
        schedule: { mode: 'cron', expression, timezone },
        firstRunAt,
      };
    }
  }
}

/**
 * The occurrence after `from` for a stored schedule, ignoring run caps. A
 * once schedule has no occurrence after it fires.
 */
export function computeNextSessionWakeupRunAt(
  schedule: SessionWakeupSchedule,
  from: Date,
): Date | null {
  switch (schedule.mode) {
    case 'once': {
      const at = new Date(schedule.at);
      return at.getTime() > from.getTime() ? at : null;
    }
    case 'interval':
      return new Date(from.getTime() + schedule.everyMinutes * MINUTE_MS);
    case 'cron':
      return nextCronOccurrence(schedule.expression, schedule.timezone, from);
  }
}

/**
 * The occurrence to schedule after a fire, or null when the wakeup is done.
 * Missed occurrences are computed from `firedAt`, not from the missed slot,
 * so a deployment that was down for hours fires a monitor once on recovery
 * rather than once per missed slot.
 */
export function resolveSessionWakeupNextRun(params: {
  schedule: SessionWakeupSchedule;
  firedAt: Date;
  runCountAfterFire: number;
  maxRuns: number | null;
  until: Date | null;
}): Date | null {
  if (params.schedule.mode === 'once') return null;
  if (params.maxRuns !== null && params.runCountAfterFire >= params.maxRuns) {
    return null;
  }
  const next = computeNextSessionWakeupRunAt(params.schedule, params.firedAt);
  if (!next) return null;
  if (params.until && next.getTime() > params.until.getTime()) return null;
  return next;
}

/**
 * Enforce the run-cap rules for a normalized schedule: caps only apply to
 * recurring schedules, tight intervals must be capped, and `until` must lie
 * ahead of the first occurrence.
 */
export function validateSessionWakeupCaps(params: {
  schedule: SessionWakeupSchedule;
  firstRunAt: Date;
  maxRuns: number | null;
  until: Date | null;
}): void {
  const { schedule } = params;
  // A once schedule is inherently a single run; a stray maxRuns or until from
  // the model is ignored rather than rejected.
  if (schedule.mode === 'once') return;
  if (params.until && params.until.getTime() <= params.firstRunAt.getTime()) {
    throw new SessionWakeupValidationError(
      `until must be later than the first occurrence at ${params.firstRunAt.toISOString()}.`,
    );
  }
  if (
    schedule.mode === 'interval' &&
    schedule.everyMinutes < SESSION_WAKEUP_UNCAPPED_MIN_INTERVAL_MINUTES &&
    params.maxRuns === null &&
    params.until === null
  ) {
    throw new SessionWakeupValidationError(
      `Intervals under ${SESSION_WAKEUP_UNCAPPED_MIN_INTERVAL_MINUTES} minutes need maxRuns or until so they cannot run forever.`,
    );
  }
}

function formatMinutes(minutes: number): string {
  if (minutes % (24 * 60) === 0) {
    const days = minutes / (24 * 60);
    return `${days} day${days === 1 ? '' : 's'}`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} hour${hours === 1 ? '' : 's'}`;
  }
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

export function describeSessionWakeupSchedule(
  schedule: SessionWakeupSchedule,
): string {
  switch (schedule.mode) {
    case 'once':
      return `once at ${schedule.at}`;
    case 'interval':
      return `every ${formatMinutes(schedule.everyMinutes)}`;
    case 'cron':
      return `cron ${schedule.expression} (${schedule.timezone})`;
  }
}
