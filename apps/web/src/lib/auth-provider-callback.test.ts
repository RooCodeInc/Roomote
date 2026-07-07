import { getAuthProviderCallbackUrl } from './auth-provider-callback';

describe('getAuthProviderCallbackUrl', () => {
  it('routes Slack through the post-auth install step', () => {
    expect(getAuthProviderCallbackUrl('slack', '/setup')).toBe(
      '/api/slack/install-after-auth?redirect=%2Fsetup',
    );
  });

  it.each(['microsoft'] as const)(
    'keeps %s on the requested redirect path',
    (provider) => {
      expect(getAuthProviderCallbackUrl(provider, '/settings')).toBe(
        '/settings',
      );
    },
  );
});
