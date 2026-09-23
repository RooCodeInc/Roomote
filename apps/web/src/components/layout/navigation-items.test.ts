import {
  getVisiblePrimaryNavItems,
  getVisibleSideNavSections,
} from './navigation-items';

describe('getVisiblePrimaryNavItems', () => {
  it('places sessions before automations for admins', () => {
    const items = getVisiblePrimaryNavItems({ isAdmin: true });

    expect(items.map((item) => item.href)).toEqual([
      '/',
      '/sessions',
      '/automations',
      '/integrations',
      '/analytics',
    ]);
  });

  it('marks Home, Automations, and Analytics as setup-gated', () => {
    const items = getVisiblePrimaryNavItems({ isAdmin: true });

    expect(
      items.filter((item) => item.requiresSetup).map((item) => item.href),
    ).toEqual(['/', '/automations', '/analytics']);
  });

  it('hides analytics from non-admins', () => {
    const items = getVisiblePrimaryNavItems({
      isAdmin: false,
    });

    expect(items.map((item) => item.href)).toEqual([
      '/',
      '/sessions',
      '/automations',
      '/integrations',
    ]);
  });

  it('shows setup-gated automations to members', () => {
    const items = getVisiblePrimaryNavItems({
      isAdmin: false,
    });

    expect(items.find((item) => item.href === '/automations')).toMatchObject({
      requiresSetup: true,
    });
  });

  it('places opted-in Results immediately after Automations for every user', () => {
    const items = getVisiblePrimaryNavItems({
      isAdmin: false,
      resultsEnabled: true,
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
      requiresSetup: true,
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
    expect(
      toHrefs(
        getVisibleSideNavSections({ isAdmin: true, resultsEnabled: true }),
      ),
    ).toEqual({
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
      manage: ['/automations', '/integrations'],
      insights: [],
    });
  });
});
