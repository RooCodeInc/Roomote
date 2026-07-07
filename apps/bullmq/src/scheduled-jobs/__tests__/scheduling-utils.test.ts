import { isWeeklyRunDueOnLocalDay } from '../scheduling-utils';

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
