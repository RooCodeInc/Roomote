import { describe, expect, it } from 'vitest';

import {
  getAccessibleSettingsNavigation,
  getSettingsNavigationItem,
} from './settings-navigation';

describe('settings navigation', () => {
  it('shows the empty state for Experimental settings', () => {
    expect(getSettingsNavigationItem('experimental')?.description).toBe(
      'No experimental features at the moment. Check back soon.',
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
