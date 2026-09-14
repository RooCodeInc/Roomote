import { isValidElement } from 'react';

const {
  canVisitorSignUpMock,
  getRequestInviteSummaryMock,
  getSignedInAuthContextMock,
  resolveAuthProviderConfigMock,
  getDeploymentAccountLinkHelpTextMock,
  redirectMock,
  signInPageClientMock,
} = vi.hoisted(() => ({
  canVisitorSignUpMock: vi.fn(),
  getRequestInviteSummaryMock: vi.fn(),
  getSignedInAuthContextMock: vi.fn(),
  resolveAuthProviderConfigMock: vi.fn(),
  getDeploymentAccountLinkHelpTextMock: vi.fn(),
  redirectMock: vi.fn(() => {
    throw new Error('NEXT_REDIRECT');
  }),
  signInPageClientMock: vi.fn(),
}));

vi.mock('next/navigation', () => ({ redirect: redirectMock }));
vi.mock('@/lib/server/access-policy', () => ({
  canVisitorSignUp: canVisitorSignUpMock,
  getRequestInviteSummary: getRequestInviteSummaryMock,
}));
vi.mock('@/lib/server/auth-context', () => ({
  getSignedInAuthContext: getSignedInAuthContextMock,
}));
vi.mock('@/lib/server/auth-provider-config', () => ({
  resolveAuthProviderConfig: resolveAuthProviderConfigMock,
}));
vi.mock('@roomote/db/server', () => ({
  getDeploymentAccountLinkHelpText: getDeploymentAccountLinkHelpTextMock,
}));
vi.mock('./page.client', () => ({
  SignInPageClient: signInPageClientMock,
}));

import Page from './page';

describe('Sign-in page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    canVisitorSignUpMock.mockResolvedValue(false);
    getRequestInviteSummaryMock.mockResolvedValue(null);
    resolveAuthProviderConfigMock.mockResolvedValue({
      enabledProviders: ['slack'],
    });
    getDeploymentAccountLinkHelpTextMock.mockResolvedValue(null);
  });

  it('redirects an authenticated user to the requested safe path without refreshing the session', async () => {
    getSignedInAuthContextMock.mockResolvedValue({ success: true });

    await expect(
      Page({ searchParams: Promise.resolve({ redirect_url: '/settings' }) }),
    ).rejects.toThrow('NEXT_REDIRECT');

    expect(getSignedInAuthContextMock).toHaveBeenCalledWith();
    expect(redirectMock).toHaveBeenCalledWith('/settings');
    expect(signInPageClientMock).not.toHaveBeenCalled();
  });

  it.each([
    ['a missing redirect', {}],
    ['an external redirect', { redirect_url: 'https://example.com' }],
    ['a protocol-relative redirect', { redirect_url: '//example.com' }],
    ['a sign-in redirect loop', { redirect_url: '/sign-in?invited=1' }],
  ])(
    'redirects an authenticated user to the homepage for %s',
    async (_, searchParams) => {
      getSignedInAuthContextMock.mockResolvedValue({ success: true });

      await expect(
        Page({ searchParams: Promise.resolve(searchParams) }),
      ).rejects.toThrow('NEXT_REDIRECT');

      expect(redirectMock).toHaveBeenCalledWith('/');
    },
  );

  it('renders the existing sign-in form for an unauthenticated visitor', async () => {
    getSignedInAuthContextMock.mockResolvedValue({
      success: false,
      error: 'Unauthorized: User required',
    });

    const result = await Page({
      searchParams: Promise.resolve({ redirect_url: '/settings' }),
    });

    expect(redirectMock).not.toHaveBeenCalled();
    expect(getSignedInAuthContextMock).toHaveBeenCalledWith();
    expect(isValidElement(result)).toBe(true);
    expect(result).toMatchObject({
      type: signInPageClientMock,
      props: {
        enabledProviders: ['slack'],
        canSignUp: false,
        inviteRole: null,
        inviteInvalid: false,
        seatLimitBlocked: false,
        accountLinkHelpText: null,
      },
    });
  });
});
