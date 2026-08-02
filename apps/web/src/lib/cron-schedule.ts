import { CronExpressionParser } from 'cron-parser';
import cronstrue from 'cronstrue';

import { CUSTOM_AUTOMATION_CRON_MAX_LENGTH } from '@roomote/types';

type ParsedCronSchedule = {
  cronExpression: string;
  summary: string;
  nextRunAt: Date;
};

/**
 * Client-side counterpart of the server's cron validation: interprets input as
 * a standard five-field cron expression and, when valid, returns the
 * normalized expression, a human-readable summary, and the next occurrence in
 * the given timezone. Returns null for anything else (including natural
 * language), which callers should resolve server-side instead. The server
 * remains the authority and re-validates on save.
 */
export function tryParseCronSchedule(
  input: string,
  timeZone: string,
  now = new Date(),
): ParsedCronSchedule | null {
  const cronExpression = input.trim().replace(/\s+/g, ' ');
  if (
    !cronExpression ||
    cronExpression.length > CUSTOM_AUTOMATION_CRON_MAX_LENGTH ||
    cronExpression.split(' ').length !== 5
  ) {
    return null;
  }

  try {
    const interval = CronExpressionParser.parse(cronExpression, {
      currentDate: now,
      tz: timeZone,
    });
    return {
      cronExpression,
      summary: cronstrue.toString(cronExpression, { verbose: false }),
      nextRunAt: interval.next().toDate(),
    };
  } catch {
    return null;
  }
}
