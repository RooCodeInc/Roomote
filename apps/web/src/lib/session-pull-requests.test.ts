import { getSessionPullRequests } from './session-pull-requests';

describe('getSessionPullRequests', () => {
  it('omits invalid pull requests derived from the all-repositories target', () => {
    expect(
      getSessionPullRequests([
        {
          pullRequests: [
            {
              repository: '__all_repositories__',
              number: 2228,
              url: 'https://github.com/__all_repositories__/pull/2228',
              status: 'open',
            },
            {
              repository: 'RooCodeInc/Roomote',
              number: 2228,
              url: 'https://github.com/RooCodeInc/Roomote/pull/2228',
              status: 'open',
            },
          ],
        },
      ]),
    ).toEqual([
      {
        repository: 'RooCodeInc/Roomote',
        number: 2228,
        url: 'https://github.com/RooCodeInc/Roomote/pull/2228',
      },
    ]);
  });
});
