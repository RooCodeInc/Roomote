import {
  getRoomoteGitHubAppSlugs,
  getRoomoteManagedGitHubLogins,
  matchesRoomoteGitHubLogin,
} from '../constants';

describe('Roomote GitHub bot identity helpers', () => {
  describe('getRoomoteGitHubAppSlugs', () => {
    it('always includes hosted-product slugs and a custom configured slug', () => {
      expect(getRoomoteGitHubAppSlugs().sort()).toEqual(
        ['roomote', 'roomote-dev'].sort(),
      );
      expect(getRoomoteGitHubAppSlugs('Acme').sort()).toEqual(
        ['acme', 'roomote', 'roomote-dev'].sort(),
      );
    });
  });

  describe('getRoomoteManagedGitHubLogins', () => {
    it('returns exact bot and app logins for hosted and configured slugs', () => {
      expect(getRoomoteManagedGitHubLogins('acme').sort()).toEqual(
        [
          'app/acme',
          'app/roomote',
          'app/roomote-dev',
          'acme[bot]',
          'roomote-dev[bot]',
          'roomote[bot]',
        ].sort(),
      );
    });

    it('does not invent open roomote-* prefix logins', () => {
      expect(
        getRoomoteManagedGitHubLogins('roomote').some((login) =>
          login.startsWith('roomote-staging'),
        ),
      ).toBe(false);
    });
  });

  describe('matchesRoomoteGitHubLogin', () => {
    it('matches exact managed logins for a custom slug', () => {
      expect(matchesRoomoteGitHubLogin('acme[bot]', 'acme')).toBe(true);
      expect(matchesRoomoteGitHubLogin('app/acme', 'acme')).toBe(true);
      expect(matchesRoomoteGitHubLogin('acme[bot]', 'roomote')).toBe(false);
    });

    it('matches roomote-dev and hosted logins without a custom slug', () => {
      expect(matchesRoomoteGitHubLogin('roomote[bot]')).toBe(true);
      expect(matchesRoomoteGitHubLogin('roomote-dev[bot]')).toBe(true);
      expect(matchesRoomoteGitHubLogin('app/roomote-dev')).toBe(true);
    });

    it('matches open roomote-* and app/roomote-* prefix forms', () => {
      expect(matchesRoomoteGitHubLogin('roomote-staging[bot]')).toBe(true);
      expect(matchesRoomoteGitHubLogin('app/roomote-canary')).toBe(true);
      expect(matchesRoomoteGitHubLogin('Roomote-Edge[bot]')).toBe(true);
    });

    it('rejects unrelated logins', () => {
      expect(matchesRoomoteGitHubLogin('octocat')).toBe(false);
      expect(matchesRoomoteGitHubLogin('app/dependabot')).toBe(false);
    });
  });
});
