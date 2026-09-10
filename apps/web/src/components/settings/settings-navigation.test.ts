import { describe, expect, it } from 'vitest';

import { getSettingsNavigationItem } from './settings-navigation';

describe('settings navigation', () => {
  it('describes Experimental settings with active opt-in features', () => {
    expect(getSettingsNavigationItem('experimental')?.description).toBe(
      'Try opt-in features that may change while they are being evaluated.',
    );
  });
});
