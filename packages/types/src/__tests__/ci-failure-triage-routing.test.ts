import {
  ciFailureTriageRepositoryRoutesSchema,
  getCiFailureTriageRepositoryRoutes,
} from '../ci-failure-triage-routing';

const route = {
  repositoryIds: ['10000000-0000-4000-8000-000000000001'],
  target: {
    provider: 'slack',
    targetKind: 'slack_channel',
    externalRef: 'C123',
  },
};

describe('CI repository routing settings', () => {
  it('distinguishes absent legacy scope from explicit empty scope', () => {
    expect(getCiFailureTriageRepositoryRoutes({})).toBeUndefined();
    expect(
      getCiFailureTriageRepositoryRoutes({ repositoryRoutes: [] }),
    ).toEqual([]);
  });
  it('roundtrips route targets and repository IDs', () => {
    expect(
      getCiFailureTriageRepositoryRoutes(
        JSON.parse(JSON.stringify({ repositoryRoutes: [route] })),
      ),
    ).toEqual([route]);
  });
  it.each([
    [route, route],
    [
      {
        ...route,
        repositoryIds: [...route.repositoryIds, ...route.repositoryIds],
      },
    ],
    [{ ...route, repositoryIds: [] }],
    [{ ...route, repositoryIds: ['owner/repo'] }],
    [{ ...route, target: { ...route.target, provider: 'discord' } }],
    [{ ...route, target: { ...route.target, externalRef: ' ' } }],
  ])('rejects invalid routes and fails closed', (...routes) => {
    expect(
      ciFailureTriageRepositoryRoutesSchema.safeParse(routes).success,
    ).toBe(false);
    expect(
      getCiFailureTriageRepositoryRoutes({ repositoryRoutes: routes }),
    ).toEqual([]);
  });
});
