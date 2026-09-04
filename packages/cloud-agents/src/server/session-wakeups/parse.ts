import {
  SESSION_WAKEUP_MAX_RUNS_LIMIT,
  SESSION_WAKEUP_SCHEDULE_GRAMMAR,
  type SessionWakeupSchedule,
} from '@roomote/types';

import {
  SessionWakeupValidationError,
  normalizeSessionWakeupSchedule,
  validateSessionWakeupCaps,
} from './schedule';

export type ParsedSessionWakeupSchedule = {
  schedule: SessionWakeupSchedule;
  firstRunAt: Date;
  maxRuns: number | null;
  until: Date | null;
};

const UNIT_MINUTES: Record<string, number> = {
  m: 1,
  min: 1,
  mins: 1,
  minute: 1,
  minutes: 1,
  h: 60,
  hr: 60,
  hrs: 60,
  hour: 60,
  hours: 60,
  d: 24 * 60,
  day: 24 * 60,
  days: 24 * 60,
};

const DURATION = String.raw`(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)`;
const DURATION_RE = new RegExp(`^${DURATION}$`, 'i');
const IN_RE = new RegExp(`^(?:once\\s+)?in\\s+${DURATION}$`, 'i');
const AT_RE = /^(?:once\s+)?at\s+(\S+)$/i;
const EVERY_RE = new RegExp(
  `^every\\s+(?:${DURATION}|(minute|hour|day))(?:\\s+(.*))?$`,
  'i',
);
const CRON_RE = /^cron\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)(?:\s+(\S+))?$/i;
const COUNT_RE =
  /^(?:x\s*(\d+)|(\d+)\s*(?:x|times|runs)|for\s+(\d+)\s+(?:runs|times))$/i;
const UNTIL_RE = /^until\s+(\S+)$/i;

function invalid(text: string, detail?: string): SessionWakeupValidationError {
  return new SessionWakeupValidationError(
    `Could not read the schedule "${text}"${detail ? `: ${detail}` : ''}. ${SESSION_WAKEUP_SCHEDULE_GRAMMAR}`,
  );
}

function durationMinutes(amount: string, unit: string): number {
  const minutes =
    Number.parseInt(amount, 10) * UNIT_MINUTES[unit.toLowerCase()]!;
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new SessionWakeupValidationError('A duration must be positive.');
  }
  return minutes;
}

/**
 * Split the trailing modifiers of an "every" schedule: any of "x3",
 * "3 times", "for 3 runs", and "until <iso>", in either order.
 */
function parseModifiers(
  text: string,
  rest: string | undefined,
): { maxRuns: number | null; until: Date | null } {
  let maxRuns: number | null = null;
  let until: Date | null = null;
  const tokens = (rest ?? '').trim().split(/\s+/).filter(Boolean);
  let index = 0;
  while (index < tokens.length) {
    const one = tokens[index]!;
    const two = tokens.slice(index, index + 2).join(' ');
    const three = tokens.slice(index, index + 3).join(' ');
    const untilMatch = UNTIL_RE.exec(two);
    if (untilMatch) {
      const parsed = new Date(untilMatch[1]!);
      if (Number.isNaN(parsed.getTime())) {
        throw invalid(text, `"${untilMatch[1]}" is not an ISO 8601 date-time`);
      }
      until = parsed;
      index += 2;
      continue;
    }
    const countMatch =
      COUNT_RE.exec(three) ?? COUNT_RE.exec(two) ?? COUNT_RE.exec(one);
    if (countMatch) {
      const count = Number.parseInt(
        countMatch[1] ?? countMatch[2] ?? countMatch[3]!,
        10,
      );
      if (!(count >= 1) || count > SESSION_WAKEUP_MAX_RUNS_LIMIT) {
        throw invalid(
          text,
          `run count must be between 1 and ${SESSION_WAKEUP_MAX_RUNS_LIMIT}`,
        );
      }
      maxRuns = count;
      index += COUNT_RE.exec(three) ? 3 : COUNT_RE.exec(two) ? 2 : 1;
      continue;
    }
    throw invalid(text, `unexpected "${one}"`);
  }
  return { maxRuns, until };
}

/**
 * Parse the single schedule string the tool accepts into the normalized
 * stored schedule plus its caps, resolving relative delays against `now`.
 */
export function parseSessionWakeupSchedule(
  input: string,
  options: { now: Date; defaultTimeZone: string },
): ParsedSessionWakeupSchedule {
  const text = input.trim().replace(/\s+/g, ' ');
  if (!text) throw invalid(input, 'it is empty');

  const inMatch = IN_RE.exec(text);
  if (inMatch) {
    const inMinutes = durationMinutes(inMatch[1]!, inMatch[2]!);
    const normalized = normalizeSessionWakeupSchedule(
      { mode: 'once', inMinutes },
      options,
    );
    return { ...normalized, maxRuns: null, until: null };
  }

  const atMatch = AT_RE.exec(text);
  if (atMatch) {
    const normalized = normalizeSessionWakeupSchedule(
      { mode: 'once', at: atMatch[1]! },
      options,
    );
    return { ...normalized, maxRuns: null, until: null };
  }

  const everyMatch = EVERY_RE.exec(text);
  if (everyMatch) {
    const everyMinutes = everyMatch[3]
      ? UNIT_MINUTES[everyMatch[3].toLowerCase()]!
      : durationMinutes(everyMatch[1]!, everyMatch[2]!);
    const normalized = normalizeSessionWakeupSchedule(
      { mode: 'interval', everyMinutes },
      options,
    );
    const caps = parseModifiers(text, everyMatch[4]);
    validateSessionWakeupCaps({ ...normalized, ...caps });
    return { ...normalized, ...caps };
  }

  const cronMatch = CRON_RE.exec(text);
  if (cronMatch) {
    const normalized = normalizeSessionWakeupSchedule(
      {
        mode: 'cron',
        expression: cronMatch[1]!,
        ...(cronMatch[2] ? { timezone: cronMatch[2] } : {}),
      },
      options,
    );
    return { ...normalized, maxRuns: null, until: null };
  }

  // A bare duration ("2m", "10 minutes") is ambiguous between a delay and a
  // cadence; say so rather than guess.
  if (DURATION_RE.test(text)) {
    throw invalid(
      text,
      'say "in ..." for a one-shot delay or "every ..." for a repeating interval',
    );
  }
  throw invalid(text);
}
