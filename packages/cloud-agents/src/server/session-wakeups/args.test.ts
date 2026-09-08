import { describe, expect, it } from 'vitest';
import { manageWakeupsInputSchema } from '@roomote/types';

import { normalizeManageWakeupsArgs } from './args';

describe('normalizeManageWakeupsArgs', () => {
  it('drops empty-string, null, and placeholder values', () => {
    expect(
      normalizeManageWakeupsArgs({
        action: 'create',
        wakeupId: '',
        name: 'Check the deploy',
        prompt: 'Tell the user to check the deploy.',
        schedule: 'in 2m',
        reportPolicy: null,
      }),
    ).toEqual({
      action: 'create',
      name: 'Check the deploy',
      prompt: 'Tell the user to check the deploy.',
      schedule: 'in 2m',
    });
    expect(
      normalizeManageWakeupsArgs({ action: 'list', wakeupId: 'none' }),
    ).toEqual({ action: 'list' });
  });

  it('makes a model-shaped create call pass the contract', () => {
    const parsed = manageWakeupsInputSchema.parse(
      normalizeManageWakeupsArgs({
        action: 'create',
        wakeupId: '',
        name: 'Check the deploy',
        prompt: 'Tell the user to check the deploy.',
        schedule: 'in 2m',
        reportPolicy: '',
      }),
    );
    expect(parsed.schedule).toBe('in 2m');
    expect(parsed.wakeupId).toBeUndefined();
    expect(parsed.reportPolicy).toBeUndefined();
  });

  it('keeps real values untouched', () => {
    expect(
      normalizeManageWakeupsArgs({
        action: 'cancel',
        wakeupId: 'abc',
        reportPolicy: 'always',
      }),
    ).toEqual({ action: 'cancel', wakeupId: 'abc', reportPolicy: 'always' });
  });
});
