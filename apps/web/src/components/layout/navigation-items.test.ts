import {
  getVisiblePrimaryNavItems,
  getVisibleSideNavSections,
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
