import { describe, expect, it } from 'vitest';

import {
  FAST_AGENT_NATIVE_TOOL_NAMES,
  getFastAgentNativeAcpKind,
} from './fast-agent-tool-catalog';
import {
  MANAGE_WAKEUPS_ACTIONS,
  MANAGE_WAKEUPS_TOOL,
  fastAgentScheduledWakeupEventSchema,
  manageWakeupsInputSchema,
  sessionWakeupScheduleSchema,
} from './session-wakeups';

describe('manage wakeups tool contract', () => {
  it('accepts optional persisted relative identity without requiring it on legacy rows', () => {
    const absolute = { mode: 'once', at: '2026-09-04T17:02:00.000Z' };
    expect(sessionWakeupScheduleSchema.parse(absolute)).toEqual(absolute);
    expect(
      sessionWakeupScheduleSchema.parse({ ...absolute, inMinutes: 2 }),
    ).toEqual({ ...absolute, inMinutes: 2 });
    for (const inMinutes of [0, -1, 1.5, 43_201, '2', null]) {
      expect(
        sessionWakeupScheduleSchema.safeParse({ ...absolute, inMinutes })
          .success,
      ).toBe(false);
    }
  });
  it('keeps every supported action in the shared Zod schema', () => {
    for (const action of MANAGE_WAKEUPS_ACTIONS) {
      expect(manageWakeupsInputSchema.parse({ action })).toEqual({ action });
    }
  });

  it('publishes the canonical descriptor and is a Fast native tool', () => {
    expect(MANAGE_WAKEUPS_TOOL.name).toBe('manage_wakeups');
    expect(FAST_AGENT_NATIVE_TOOL_NAMES.manageWakeups).toBe(
      MANAGE_WAKEUPS_TOOL.name,
    );
    expect(getFastAgentNativeAcpKind('manage_wakeups')).toBe('task');
    expect(MANAGE_WAKEUPS_TOOL.description).toContain('"in 20m"');
    expect(MANAGE_WAKEUPS_TOOL.description).toContain('There is no pause.');
    expect(MANAGE_WAKEUPS_TOOL.description).toContain(
      'Never poll, sleep, or wait',
    );
    expect(MANAGE_WAKEUPS_TOOL.inputSchema.schedule.description).toContain(
      'cron 0 9 * * 1-5 America/New_York',
    );
  });

  it('takes the schedule as one string and nothing else schedule-shaped', () => {
    expect(Object.keys(MANAGE_WAKEUPS_TOOL.inputSchema).sort()).toEqual([
      'action',
      'name',
      'prompt',
      'reportPolicy',
      'schedule',
      'wakeupId',
    ]);
    expect(
      manageWakeupsInputSchema.parse({
        action: 'create',
        name: 'Check the deploy',
        prompt: 'Tell the user to check the deploy.',
        schedule: '  in 2m ',
      }).schedule,
    ).toBe('in 2m');
    expect(
      manageWakeupsInputSchema.safeParse({
        action: 'create',
        schedule: { mode: 'once', inMinutes: 2 },
      }).success,
    ).toBe(false);
  });

  it('validates the scheduled wakeup platform event', () => {
    expect(
      fastAgentScheduledWakeupEventSchema.safeParse({
        type: 'scheduled_wakeup',
        eventId: 'wakeup-1:3',
        wakeupId: 'wakeup-1',
        name: 'Check PR #85',
        prompt: 'Check whether PR #85 merged.',
        runNumber: 3,
        maxRuns: null,
        firedAt: '2026-09-04T17:10:00.000Z',
        nextRunAt: '2026-09-04T17:20:00.000Z',
        reportPolicy: 'only_when_notable',
        createdByUserId: 'user-1',
      }).success,
    ).toBe(true);
  });
});
