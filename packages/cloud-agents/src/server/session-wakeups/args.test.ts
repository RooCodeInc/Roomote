import { describe, expect, it } from 'vitest';
import { manageWakeupsInputSchema } from '@roomote/types';

import { normalizeManageWakeupsArgs } from './args';

describe('normalizeManageWakeupsArgs', () => {
  it('drops empty-string and null placeholders at every depth', () => {
    expect(
      normalizeManageWakeupsArgs({
        action: 'create',
        wakeupId: '',
        name: 'Check the deploy',
        prompt: 'Tell the user to check the deploy.',
        schedule: { mode: 'once', inMinutes: 2, at: '' },
        until: null,
        reportPolicy: '',
      }),
    ).toEqual({
      action: 'create',
      name: 'Check the deploy',
      prompt: 'Tell the user to check the deploy.',
      schedule: { mode: 'once', inMinutes: 2 },
    });
  });

  it('makes a model-shaped once schedule pass the strict contract', () => {
    const parsed = manageWakeupsInputSchema.parse(
      normalizeManageWakeupsArgs({
        action: 'create',
        wakeupId: '',
        name: 'Check the deploy',
        prompt: 'Tell the user to check the deploy.',
        schedule: { mode: 'once', inMinutes: 2, at: '' },
        until: '',
      }),
    );
    expect(parsed.schedule).toEqual({ mode: 'once', inMinutes: 2 });
    expect(parsed.wakeupId).toBeUndefined();
    expect(parsed.until).toBeUndefined();
  });

  it('drops placeholder strings and non-positive caps but keeps real values', () => {
    expect(
      normalizeManageWakeupsArgs({
        action: 'cancel',
        wakeupId: 'abc',
        maxRuns: 0,
        until: 'none',
        schedule: { mode: 'cron', expression: '0 9 * * *', timezone: 'UTC' },
      }),
    ).toEqual({
      action: 'cancel',
      wakeupId: 'abc',
      schedule: { mode: 'cron', expression: '0 9 * * *', timezone: 'UTC' },
    });
  });
});
