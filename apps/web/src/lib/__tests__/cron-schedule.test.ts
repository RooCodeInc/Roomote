// pnpm test src/lib/__tests__/cron-schedule.test.ts

import { tryParseCronSchedule } from '../cron-schedule';

const NOW = new Date('2026-08-01T00:00:00Z');

describe('tryParseCronSchedule', () => {
  it('parses a five-field cron expression with summary and next run', () => {
    const parsed = tryParseCronSchedule('0 9 * * 1-5', 'UTC', NOW);
    expect(parsed).not.toBeNull();
    expect(parsed?.cronExpression).toBe('0 9 * * 1-5');
    expect(parsed?.summary).toBe('At 09:00 AM, Monday through Friday');
    // 2026-08-01 is a Saturday, so the next weekday run is Monday the 3rd.
    expect(parsed?.nextRunAt.toISOString()).toBe('2026-08-03T09:00:00.000Z');
  });

  it('computes the next run in the given timezone', () => {
    const parsed = tryParseCronSchedule('0 9 * * *', 'America/New_York', NOW);
    // 9:00 AM EDT is 13:00 UTC.
    expect(parsed?.nextRunAt.toISOString()).toBe('2026-08-01T13:00:00.000Z');
  });

  it('labels wildcard-date schedules as daily', () => {
    expect(tryParseCronSchedule('0 9 * * *', 'UTC', NOW)?.summary).toBe(
      'Daily at 09:00 AM',
    );
    // Interval schedules keep cronstrue's own phrasing.
    expect(tryParseCronSchedule('*/15 * * * *', 'UTC', NOW)?.summary).toBe(
      'Every 15 minutes',
    );
  });

  it('normalizes surrounding and repeated whitespace', () => {
    const parsed = tryParseCronSchedule('  0  9 * *  * ', 'UTC', NOW);
    expect(parsed?.cronExpression).toBe('0 9 * * *');
  });

  it('returns null for natural language input', () => {
    expect(tryParseCronSchedule('every weekday at 9am', 'UTC', NOW)).toBeNull();
    expect(
      tryParseCronSchedule('daily at noon somehow', 'UTC', NOW),
    ).toBeNull();
  });

  it('returns null for non-five-field expressions', () => {
    expect(tryParseCronSchedule('0 9 * *', 'UTC', NOW)).toBeNull();
    expect(tryParseCronSchedule('0 0 9 * * 1-5', 'UTC', NOW)).toBeNull();
  });

  it('returns null for invalid field values and empty input', () => {
    expect(tryParseCronSchedule('99 99 * * *', 'UTC', NOW)).toBeNull();
    expect(tryParseCronSchedule('', 'UTC', NOW)).toBeNull();
    expect(tryParseCronSchedule('   ', 'UTC', NOW)).toBeNull();
  });
});
