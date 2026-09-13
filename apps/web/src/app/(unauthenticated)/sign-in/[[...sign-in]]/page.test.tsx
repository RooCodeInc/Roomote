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

  it('redirects an authenticated user to the homepage without refreshing the session', async () => {
    getSignedInAuthContextMock.mockResolvedValue({ success: true });

    await expect(
      Page({ searchParams: Promise.resolve({ redirect_url: '/settings' }) }),
    ).rejects.toThrow('NEXT_REDIRECT');

    expect(getSignedInAuthContextMock).toHaveBeenCalledWith();
    expect(redirectMock).toHaveBeenCalledWith('/');
    expect(signInPageClientMock).not.toHaveBeenCalled();
  });

  it('renders the existing sign-in form for an unauthenticated visitor', async () => {
    getSignedInAuthContextMock.mockResolvedValue({
      success: false,
      error: 'Unauthorized: User required',
    });

    const result = await Page({ searchParams: Promise.resolve({}) });

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
