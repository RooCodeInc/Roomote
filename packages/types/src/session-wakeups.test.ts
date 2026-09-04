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
  sessionWakeupScheduleInputSchema,
} from './session-wakeups';

describe('manage wakeups tool contract', () => {
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
    expect(MANAGE_WAKEUPS_TOOL.description).toContain('mode "once"');
    expect(MANAGE_WAKEUPS_TOOL.description).toContain('There is no pause.');
    expect(MANAGE_WAKEUPS_TOOL.description).toContain(
      'Never poll, sleep, or wait',
    );
  });

  it('rejects a schedule that mixes modes', () => {
    expect(
      sessionWakeupScheduleInputSchema.safeParse({
        mode: 'once',
        inMinutes: 4,
        everyMinutes: 10,
      }).success,
    ).toBe(false);
    expect(
      sessionWakeupScheduleInputSchema.safeParse({
        mode: 'interval',
        everyMinutes: 10,
        at: '2026-09-04T15:00:00Z',
      }).success,
    ).toBe(false);
  });

  it('accepts each schedule mode on its own', () => {
    expect(
      sessionWakeupScheduleInputSchema.parse({ mode: 'once', inMinutes: 4 }),
    ).toEqual({ mode: 'once', inMinutes: 4 });
    expect(
      sessionWakeupScheduleInputSchema.parse({
        mode: 'interval',
        everyMinutes: 15,
      }),
    ).toEqual({ mode: 'interval', everyMinutes: 15 });
    expect(
      sessionWakeupScheduleInputSchema.parse({
        mode: 'cron',
        expression: '0 9 * * 1-5',
        timezone: 'America/New_York',
      }),
    ).toEqual({
      mode: 'cron',
      expression: '0 9 * * 1-5',
      timezone: 'America/New_York',
    });
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
