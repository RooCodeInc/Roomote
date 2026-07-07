import { FeatureFlag } from '@roomote/feature-flags';

import { getVisiblePrimaryNavItems } from './navigation-items';

const featureFlags = {} as Record<FeatureFlag, boolean>;

describe('getVisiblePrimaryNavItems', () => {
  it('places automations before task history for admins', () => {
    const items = getVisiblePrimaryNavItems(featureFlags, { isAdmin: true });

    expect(items.map((item) => item.href)).toEqual([
      '/',
      '/automations',
      '/tasks',
      '/analytics',
    ]);
  });

  it('keeps analytics visible for non-admins', () => {
    const items = getVisiblePrimaryNavItems(featureFlags, {
      isAdmin: false,
    });

    expect(items.map((item) => item.href)).toEqual([
      '/',
      '/tasks',
      '/analytics',
    ]);
  });

  it('hides automations from non-admins', () => {
    const items = getVisiblePrimaryNavItems(featureFlags, {
      isAdmin: false,
    });

    expect(items.map((item) => item.href)).toEqual([
      '/',
      '/tasks',
      '/analytics',
    ]);
  });
});
