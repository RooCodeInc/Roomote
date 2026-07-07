import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const { replaceMock, refreshMock, signInOauth2Mock } = vi.hoisted(() => ({
  replaceMock: vi.fn(),
  refreshMock: vi.fn(),
  signInOauth2Mock: vi.fn(),
}));

let searchParams = new URLSearchParams();

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    replace: replaceMock,
    refresh: refreshMock,
  }),
  useSearchParams: () => searchParams,
}));

vi.mock('@/lib/auth-client', () => ({
  authClient: {
    signIn: {
      oauth2: signInOauth2Mock,
    },
  },
}));

// Self-fetching via tRPC; covered by its own client test.
vi.mock('@/components/layout', () => ({
  OriginMismatchAlert: () => null,
}));

import { AuthForm } from './auth-form';

describe('AuthForm', () => {
  beforeEach(() => {
    searchParams = new URLSearchParams();
    signInOauth2Mock.mockResolvedValue({
      data: { url: 'https://oauth.example.com' },
      error: null,
    });
  });

  it('starts Slack sign-in with the requested redirect path', async () => {
    searchParams = new URLSearchParams('redirect_url=/tasks?view=mine');

    render(<AuthForm />);

    fireEvent.click(
      screen.getByRole('button', { name: 'Continue with Slack' }),
    );

    await waitFor(() => {
      expect(signInOauth2Mock).toHaveBeenCalledWith({
        providerId: 'slack',
        callbackURL:
          '/api/slack/install-after-auth?redirect=%2Ftasks%3Fview%3Dmine',
      });
    });
    expect(replaceMock).not.toHaveBeenCalled();
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('defaults sign-in to setup when no redirect path is requested', async () => {
    render(<AuthForm />);

    fireEvent.click(
      screen.getByRole('button', { name: 'Continue with Microsoft Teams' }),
    );

    await waitFor(() => {
      expect(signInOauth2Mock).toHaveBeenCalledWith({
        providerId: 'microsoft-entra-id',
        callbackURL: '/setup',
      });
    });
  });

  it('falls back to setup for unsafe redirect URLs', async () => {
    searchParams = new URLSearchParams('redirect_url=https://example.com');

    render(<AuthForm />);

    fireEvent.click(
      screen.getByRole('button', { name: 'Continue with Microsoft Teams' }),
    );

    await waitFor(() => {
      expect(signInOauth2Mock).toHaveBeenCalledWith({
        providerId: 'microsoft-entra-id',
        callbackURL: '/setup',
      });
    });
  });

  it('starts Microsoft Teams sign-in through generic OAuth with the requested redirect path', async () => {
    searchParams = new URLSearchParams('redirect_url=/settings');

    render(<AuthForm />);

    fireEvent.click(
      screen.getByRole('button', { name: 'Continue with Microsoft Teams' }),
    );

    await waitFor(() => {
      expect(signInOauth2Mock).toHaveBeenCalledWith({
        providerId: 'microsoft-entra-id',
        callbackURL: '/settings',
      });
    });
  });

  it('redirects locally if the social call completes without an external URL', async () => {
    signInOauth2Mock.mockResolvedValue({ data: {}, error: null });
    searchParams = new URLSearchParams('redirect_url=/settings');

    render(<AuthForm />);

    fireEvent.click(
      screen.getByRole('button', { name: 'Continue with Slack' }),
    );

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith(
        '/api/slack/install-after-auth?redirect=%2Fsettings',
      );
    });
    expect(refreshMock).toHaveBeenCalled();
  });

  it('shows Better Auth errors without redirecting', async () => {
    signInOauth2Mock.mockResolvedValue({
      data: null,
      error: { message: 'Provider is not configured' },
    });

    render(<AuthForm />);

    fireEvent.click(
      screen.getByRole('button', { name: 'Continue with Slack' }),
    );

    expect(await screen.findByText('Provider is not configured')).toBeVisible();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it('shows provider configuration guidance', () => {
    render(<AuthForm />);

    expect(
      screen.getByRole('heading', {
        name: 'Hi there, welcome to Roomote.',
      }),
    ).toBeVisible();
    expect(screen.getByLabelText('Email')).toBeVisible();
    expect(screen.getByLabelText('Password')).toBeVisible();
  });

  it('omits provider buttons when no provider is configured', () => {
    render(<AuthForm enabledProviders={[]} />);

    expect(
      screen.queryByRole('button', { name: 'Continue with Slack' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Continue with Telegram' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Continue with Microsoft Teams' }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('heading', {
        name: 'Hi there, welcome to Roomote.',
      }),
    ).toBeVisible();
    expect(screen.getByLabelText('Email')).toBeVisible();
    expect(screen.getByLabelText('Password')).toBeVisible();
  });

  it('does not show Telegram as a sign-in provider', () => {
    render(<AuthForm />);

    expect(
      screen.queryByRole('button', { name: 'Continue with Telegram' }),
    ).not.toBeInTheDocument();
  });

  it('omits the social section divider when no provider is configured', () => {
    render(<AuthForm enabledProviders={[]} />);

    expect(screen.queryByText(/\bor\b/)).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', {
        name: /create account|sign in/i,
      }),
    ).toBeVisible();
  });

  it('offers account creation to invited visitors', () => {
    render(<AuthForm canSignUp />);

    expect(
      screen.getByRole('button', { name: 'Need an account? Create one' }),
    ).toBeVisible();
    expect(
      screen.queryByText(/ask an admin for an invite/i),
    ).not.toBeInTheDocument();
  });

  it('hides account creation and points at an admin without an invite', () => {
    render(<AuthForm />);

    expect(
      screen.queryByRole('button', { name: /create/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeVisible();
    expect(
      screen.getByText(/Need an account\? Forgot your password\?/),
    ).toBeVisible();
    expect(screen.getByText(/Ask your admin\./)).toBeVisible();
  });

  it('can hide the account and password help copy for bootstrap sign-up', () => {
    render(
      <AuthForm canSignUp enabledProviders={[]} hideModeSwitchMessage={true} />,
    );

    expect(
      screen.queryByText(/Need an account\? Forgot your password\?/),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/Ask your admin\./)).not.toBeInTheDocument();
  });

  it('starts invited visitors in sign-up mode', () => {
    searchParams = new URLSearchParams('invited=1');

    render(<AuthForm canSignUp />);

    expect(screen.getByLabelText('Name')).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Create account' }),
    ).toBeVisible();
  });

  it('keeps uninvited visitors in sign-in mode even with the invited param', () => {
    searchParams = new URLSearchParams('invited=1');

    render(<AuthForm />);

    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeVisible();
  });

  it('shows a server-provided notice above the form', () => {
    render(
      <AuthForm noticeMessage="This deployment has reached its licensed user limit. Ask an admin to free a seat or add a license key, then sign in again." />,
    );

    expect(screen.getByText(/reached its licensed user limit/)).toBeVisible();
    // Sign-in stays available: existing users are never blocked by the gate.
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeVisible();
  });

  it('shows no notice by default', () => {
    render(<AuthForm />);

    expect(
      screen.queryByText(/reached its licensed user limit/),
    ).not.toBeInTheDocument();
  });
});
