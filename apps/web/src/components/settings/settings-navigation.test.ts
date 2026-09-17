import { describe, expect, it } from 'vitest';

import {
  getAccessibleSettingsNavigation,
  getSettingsNavigationItem,
} from './settings-navigation';

describe('settings navigation', () => {
  it('describes Experimental settings as deployment-wide controls', () => {
    expect(getSettingsNavigationItem('experimental')?.description).toBe(
      'Manage deployment-wide features that may change while they are being evaluated.',
    );
  });

  it('makes Experimental settings available only to admins', () => {
    const items = getAccessibleSettingsNavigation({
      isAdmin: false,
      cloudEnabled: false,
    });

    expect(items.map((item) => item.id)).not.toContain('experimental');
    expect(items.map((item) => item.id)).not.toContain('models');
  });
});
