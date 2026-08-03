import { getVisiblePrimaryNavItems } from './navigation-items';

describe('getVisiblePrimaryNavItems', () => {
  it('places automations before task history for admins', () => {
    const items = getVisiblePrimaryNavItems({ isAdmin: true });

    expect(items.map((item) => item.href)).toEqual([
      '/',
      '/automations',
      '/tasks',
      '/analytics',
    ]);
  });

  it('hides analytics from non-admins', () => {
    const items = getVisiblePrimaryNavItems({
      isAdmin: false,
    });

    expect(items.map((item) => item.href)).toEqual(['/', '/tasks']);
  });

  it('hides automations from non-admins', () => {
    const items = getVisiblePrimaryNavItems({
      isAdmin: false,
    });

    expect(items.map((item) => item.href)).toEqual(['/', '/tasks']);
  });
});
