import { describe, expect, it } from 'vitest';

import { getSettingsNavigationItem } from './settings-navigation';

describe('settings navigation', () => {
  it('shows the empty state for Experimental settings', () => {
    expect(getSettingsNavigationItem('experimental')?.description).toBe(
      'No experimental features at the moment. Check back soon.',
    );
  });
});
