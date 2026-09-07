import { describe, expect, it } from 'vitest';

import { formatAutomationTriggerLabel } from './automation-result-metadata';

describe('automation result metadata', () => {
  it('formats manual and scheduled trigger labels', () => {
    expect(formatAutomationTriggerLabel('manual', 'weekly')).toBe('Manual');
    expect(formatAutomationTriggerLabel('schedule', 'daily')).toBe('Daily');
    expect(formatAutomationTriggerLabel('schedule', 'weekly')).toBe('Weekly');
    expect(formatAutomationTriggerLabel('schedule', 'every_hour')).toBe(
      'Hourly',
    );
    expect(formatAutomationTriggerLabel('schedule', 'cron')).toBe('Scheduled');
  });
});
