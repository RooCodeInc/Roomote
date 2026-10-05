import {
  isManagerStatsRunDueOnLocalPeriod,
  isWeeklyRunDueOnLocalDay,
} from '../scheduling-utils';

describe('isWeeklyRunDueOnLocalDay', () => {
  const friday = 5;

  it('is due on the scheduled local day at the scheduled local hour', () => {
    expect(
      isWeeklyRunDueOnLocalDay({
        now: new Date('2026-05-01T16:00:00.000Z'),
        timeZone: 'UTC',
        lastRunAt: null,
        scheduleDayLocal: friday,
        scheduleHourLocal: 16,
      }),
    ).toBe(true);
  });

  it('is not due before the scheduled local hour', () => {
    expect(
      isWeeklyRunDueOnLocalDay({
        now: new Date('2026-05-01T15:59:00.000Z'),
        timeZone: 'UTC',
        lastRunAt: null,
        scheduleDayLocal: friday,
        scheduleHourLocal: 16,
      }),
    ).toBe(false);
  });

  it('is not due on another local day', () => {
    expect(
      isWeeklyRunDueOnLocalDay({
        now: new Date('2026-05-02T16:00:00.000Z'),
        timeZone: 'UTC',
        lastRunAt: null,
        scheduleDayLocal: friday,
        scheduleHourLocal: 16,
      }),
    ).toBe(false);
  });

  it('is not due twice on the same local day', () => {
    expect(
      isWeeklyRunDueOnLocalDay({
        now: new Date('2026-05-01T18:00:00.000Z'),
        timeZone: 'UTC',
        lastRunAt: new Date('2026-05-01T16:00:00.000Z'),
        scheduleDayLocal: friday,
        scheduleHourLocal: 16,
      }),
    ).toBe(false);
  });

  it('uses the org timezone for the Friday boundary', () => {
    expect(
      isWeeklyRunDueOnLocalDay({
        now: new Date('2026-05-02T00:00:00.000Z'),
        timeZone: 'America/Los_Angeles',
        lastRunAt: null,
        scheduleDayLocal: friday,
        scheduleHourLocal: 16,
      }),
    ).toBe(true);
  });
});

describe('isManagerStatsRunDueOnLocalPeriod', () => {
  it.each([
    ['daily', new Date('2026-05-04T17:00:00.000Z')],
    ['weekly', new Date('2026-05-08T17:00:00.000Z')],
    ['monthly', new Date('2026-05-31T17:00:00.000Z')],
  ] as const)('runs at the %s 5 PM boundary', (frequency, now) => {
    expect(
      isManagerStatsRunDueOnLocalPeriod({
        now,
        timeZone: 'UTC',
        lastRunAt: null,
        frequency,
      }),
    ).toBe(true);
  });

  it('waits until 5 PM local time', () => {
    expect(
      isManagerStatsRunDueOnLocalPeriod({
        now: new Date('2026-05-08T16:59:00.000Z'),
        timeZone: 'UTC',
        lastRunAt: null,
        frequency: 'weekly',
      }),
    ).toBe(false);
  });

  it('does not repeat a weekly boundary after it has already run', () => {
    expect(
      isManagerStatsRunDueOnLocalPeriod({
        now: new Date('2026-05-08T18:00:00.000Z'),
        timeZone: 'UTC',
        lastRunAt: new Date('2026-05-08T17:00:00.000Z'),
        frequency: 'weekly',
      }),
    ).toBe(false);
  });

  it('does not repeat a monthly run and handles DST in the deployment timezone', () => {
    expect(
      isManagerStatsRunDueOnLocalPeriod({
        now: new Date('2026-04-01T00:00:00.000Z'),
        timeZone: 'America/New_York',
        lastRunAt: new Date('2026-03-31T21:00:00.000Z'),
        frequency: 'monthly',
      }),
    ).toBe(false);
    expect(
      isManagerStatsRunDueOnLocalPeriod({
        now: new Date('2026-04-30T21:00:00.000Z'),
        timeZone: 'America/New_York',
        lastRunAt: null,
        frequency: 'monthly',
      }),
    ).toBe(true);
  });
});
