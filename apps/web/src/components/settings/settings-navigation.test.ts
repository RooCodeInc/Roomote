import { describe, expect, it } from 'vitest';

import {
  getAccessibleSettingsNavigation,
  getSettingsNavigationItem,
} from './settings-navigation';

describe('settings navigation', () => {
  it('describes Experimental settings with active opt-in features', () => {
    expect(getSettingsNavigationItem('experimental')?.description).toBe(
      'Try opt-in features that may change while they are being evaluated.',
    );
  });

  it('makes Experimental settings available to members', () => {
    const items = getAccessibleSettingsNavigation({
      isAdmin: false,
      cloudEnabled: false,
    });

    expect(items.map((item) => item.id)).toContain('experimental');
    expect(items.map((item) => item.id)).not.toContain('models');
  });
});
