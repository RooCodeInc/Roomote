import { buildScheduledAutomationOccurrenceKey } from '../fast-automation-runner';

describe('buildScheduledAutomationOccurrenceKey', () => {
  it('uses the deployment-local date for daily occurrences', () => {
    expect(
      buildScheduledAutomationOccurrenceKey({
        automationKey: 'announcer',
        frequency: 'daily',
        now: new Date('2026-08-24T01:00:00Z'),
        timeZone: 'America/Los_Angeles',
      }),
    ).toBe('announcer:daily:2026-08-23');
  });

  it('deduplicates weekly retries across the same local cadence week', () => {
    const input = {
      automationKey: 'announcer' as const,
      frequency: 'weekly',
      timeZone: 'UTC',
    };
    expect(
      buildScheduledAutomationOccurrenceKey({
        ...input,
        now: new Date('2026-08-24T01:00:00Z'),
      }),
    ).toBe(
      buildScheduledAutomationOccurrenceKey({
        ...input,
        now: new Date('2026-08-30T23:00:00Z'),
      }),
    );
  });
});
