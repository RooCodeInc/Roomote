import { getVisiblePrimaryNavItems } from './navigation-items';

describe('getVisiblePrimaryNavItems', () => {
  it('places sessions before automations for admins', () => {
    const items = getVisiblePrimaryNavItems({ isAdmin: true });

    expect(items.map((item) => item.href)).toEqual([
      '/',
      '/sessions',
      '/automations',
      '/analytics',
    ]);
  });

  it('hides analytics from non-admins', () => {
    const items = getVisiblePrimaryNavItems({
      isAdmin: false,
    });

    expect(items.map((item) => item.href)).toEqual(['/', '/sessions']);
  });

  it('hides automations from non-admins', () => {
    const items = getVisiblePrimaryNavItems({
      isAdmin: false,
    });

    expect(items.map((item) => item.href)).toEqual(['/', '/sessions']);
  });
});
