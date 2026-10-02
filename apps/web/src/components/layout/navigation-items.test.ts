import {
  getVisiblePrimaryNavItems,
  getVisibleSideNavSections,
  isVisiblePrimaryNavPath,
  matchesPrimaryNavPath,
} from './navigation-items';

describe('getVisiblePrimaryNavItems', () => {
  it('keeps Results in the main navigation for admins', () => {
    const items = getVisiblePrimaryNavItems({ isAdmin: true });

    expect(items.map((item) => item.href)).toEqual([
      '/',
      '/sessions',
      '/automations',
      '/results',
      '/integrations',
      '/analytics',
    ]);
  });

  it('shows Results and hides analytics from non-admins', () => {
    const items = getVisiblePrimaryNavItems({
      isAdmin: false,
    });

    expect(items.map((item) => item.href)).toEqual([
      '/',
      '/sessions',
      '/automations',
      '/results',
      '/integrations',
    ]);
    expect(items.find((item) => item.href === '/results')).toMatchObject({
      label: 'Results',
    });
  });
});

describe('getVisibleSideNavSections', () => {
  const toHrefs = (sections: ReturnType<typeof getVisibleSideNavSections>) =>
    Object.fromEntries(
      Object.entries(sections).map(([section, items]) => [
        section,
        items.map((item) => item.href),
      ]),
    );

  it('keeps Analytics in its own section for admins', () => {
    expect(toHrefs(getVisibleSideNavSections({ isAdmin: true }))).toEqual({
      home: ['/'],
      sessions: ['/sessions'],
      manage: ['/automations', '/results', '/integrations'],
      insights: ['/analytics'],
    });
  });

  it('leaves the insights section empty for members', () => {
    expect(toHrefs(getVisibleSideNavSections({ isAdmin: false }))).toEqual({
      home: ['/'],
      sessions: ['/sessions'],
      manage: ['/automations', '/results', '/integrations'],
      insights: [],
    });
  });
});

describe('isVisiblePrimaryNavPath', () => {
  it.each([
    '/',
    '/sessions',
    '/automations',
    '/results',
    '/integrations',
    '/analytics',
  ])('recognizes %s as an admin navigation path', (pathname) => {
    expect(isVisiblePrimaryNavPath(pathname, { isAdmin: true })).toBe(true);
  });

  it('recognizes navigation subpaths and rejects unrelated routes', () => {
    expect(isVisiblePrimaryNavPath('/analytics/costs', { isAdmin: true })).toBe(
      true,
    );
    expect(isVisiblePrimaryNavPath('/tasks', { isAdmin: true })).toBe(true);
    expect(isVisiblePrimaryNavPath('/cloud-agents', { isAdmin: true })).toBe(
      true,
    );
    expect(isVisiblePrimaryNavPath('/setup', { isAdmin: true })).toBe(false);
  });

  it('does not expose admin-only navigation paths to members', () => {
    expect(
      isVisiblePrimaryNavPath('/analytics/costs', { isAdmin: false }),
    ).toBe(false);
  });
});

describe('matchesPrimaryNavPath', () => {
  const items = getVisiblePrimaryNavItems({ isAdmin: true });
  const homeItem = items.find((item) => item.href === '/')!;
  const sessionsItem = items.find((item) => item.href === '/sessions')!;

  it('matches the home route exactly', () => {
    expect(matchesPrimaryNavPath('/', homeItem)).toBe(true);
    expect(matchesPrimaryNavPath('/home', homeItem)).toBe(false);
    expect(matchesPrimaryNavPath('//', homeItem)).toBe(false);
  });

  it('matches nested routes for prefix-based navigation items', () => {
    expect(matchesPrimaryNavPath('/sessions/session-123', sessionsItem)).toBe(
      true,
    );
    expect(matchesPrimaryNavPath('/sessions/', sessionsItem)).toBe(true);
    expect(matchesPrimaryNavPath('/session-123', sessionsItem)).toBe(false);
  });
});
