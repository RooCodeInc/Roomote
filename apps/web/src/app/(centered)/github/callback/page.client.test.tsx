// pnpm --filter @roomote/web test src/app/\(centered\)/github/callback/page.client.test.tsx

import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { encodeRecord } from '@/lib';

import Page from './GitHubCallbackPage';

const mockPush = vi.fn();
const mockReplace = vi.fn();
const mockSyncInstallMutate = vi.fn();
const mockFinishInstallMutate = vi.fn();
const mockFinishAppManifestMutate = vi.fn();
const mockFinishAuthenticationMutate = vi.fn();

let searchParams = new URLSearchParams();
let userState:
  | { authStatus: 'signed-in'; isSignedIn: true; user: Record<string, never> }
  | {
      authStatus: 'signed-out';
      isSignedIn: false;
      user: null;
    };

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
    replace: mockReplace,
  }),
  usePathname: () => '/github/callback',
  useSearchParams: () => searchParams,
}));

vi.mock('@/hooks/useUser', () => ({
  useUser: () => userState,
  useSetupBootstrapOpen: () => false,
}));

vi.mock('@/hooks/github', () => ({
  useFinishCreateGitHubAppManifest: (options: {
    onSuccess: (
      result:
        | { success: true; installUrl: string }
        | { success: false; error: string },
    ) => void;
    onError: (error: Error) => void;
  }) => ({
    mutate: (code: string) => mockFinishAppManifestMutate(code, options),
  }),
  useFinishAuthenticateGitHubAccount: () => ({
    mutate: mockFinishAuthenticationMutate,
  }),
  useFinishCreateGitHubInstallation: () => ({
    mutate: mockFinishInstallMutate,
  }),
  useSyncGitHubInstallation: () => ({
    mutate: mockSyncInstallMutate,
  }),
}));

describe('GitHub callback page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    searchParams = new URLSearchParams();
    userState = {
      authStatus: 'signed-in',
      isSignedIn: true,
      user: {},
    };
  });

  it('redirects signed-out installation callbacks to sign-in instead of reporting success', async () => {
    searchParams = new URLSearchParams({
      installation_id: '123',
    });
    userState = {
      authStatus: 'signed-out',
      isSignedIn: false,
      user: null,
    };

    render(<Page />);

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith(
        '/sign-in?redirect_url=%2Fgithub%2Fcallback%3Finstallation_id%3D123',
      );
    });

    expect(mockSyncInstallMutate).not.toHaveBeenCalled();
    expect(screen.getByText('GitHub Linking...')).toBeInTheDocument();
    expect(screen.queryByText('GitHub Linked')).not.toBeInTheDocument();
  });

  it('syncs the installation when the user is signed in', async () => {
    searchParams = new URLSearchParams({
      installation_id: '123',
    });

    render(<Page />);

    await waitFor(() => {
      expect(mockSyncInstallMutate).toHaveBeenCalledWith(123);
    });

    expect(mockReplace).not.toHaveBeenCalled();
    expect(mockFinishInstallMutate).not.toHaveBeenCalled();
    expect(mockFinishAppManifestMutate).not.toHaveBeenCalled();
    expect(mockFinishAuthenticationMutate).not.toHaveBeenCalled();
  });

  it('finishes the app manifest flow when state requests it', async () => {
    searchParams = new URLSearchParams({
      code: 'manifest-code',
      state: encodeRecord({
        mode: 'github-app-manifest',
        redirect: '/setup?step=source-control-connect',
      }),
    });

    render(<Page />);

    await waitFor(() => {
      expect(mockFinishAppManifestMutate).toHaveBeenCalledWith(
        'manifest-code',
        expect.any(Object),
      );
    });

    expect(mockSyncInstallMutate).not.toHaveBeenCalled();
    expect(mockFinishInstallMutate).not.toHaveBeenCalled();
    expect(mockFinishAuthenticationMutate).not.toHaveBeenCalled();
  });

  it('redirects to the returned install URL after a successful manifest finish', async () => {
    const originalLocation = window.location;
    const locationReplacement = {
      ...originalLocation,
      href: 'http://localhost/github/callback',
    };

    Object.defineProperty(window, 'location', {
      configurable: true,
      value: locationReplacement,
    });

    mockFinishAppManifestMutate.mockImplementation((_code, options) => {
      options.onSuccess({
        success: true,
        installUrl: 'https://github.com/apps/roomote/installations/new',
      });
    });
    searchParams = new URLSearchParams({
      code: 'manifest-code',
      state: encodeRecord({ mode: 'github-app-manifest' }),
    });

    render(<Page />);

    await waitFor(() => {
      expect(window.location.href).toBe(
        'https://github.com/apps/roomote/installations/new',
      );
    });

    Object.defineProperty(window, 'location', {
      configurable: true,
      value: originalLocation,
    });
  });

  it('shows an error when a manifest callback is missing a code', async () => {
    searchParams = new URLSearchParams({
      state: encodeRecord({ mode: 'github-app-manifest' }),
    });

    render(<Page />);

    expect(
      await screen.findByText('Missing manifest code. Please try again.'),
    ).toBeInTheDocument();
    expect(mockFinishAppManifestMutate).not.toHaveBeenCalled();
    expect(mockSyncInstallMutate).not.toHaveBeenCalled();
  });

  it('shows an error when manifest finish fails', async () => {
    mockFinishAppManifestMutate.mockImplementation((_code, options) => {
      options.onSuccess({
        success: false,
        error: 'Manifest conversion failed.',
      });
    });
    searchParams = new URLSearchParams({
      code: 'manifest-code',
      state: encodeRecord({ mode: 'github-app-manifest' }),
    });

    render(<Page />);

    expect(
      await screen.findByText('Manifest conversion failed.'),
    ).toBeInTheDocument();
  });

  it('sends setup-originated errors back to the source-control configuration step', async () => {
    const originalLocation = window.location;
    const assignMock = vi.fn();

    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalLocation, assign: assignMock },
    });

    mockFinishAppManifestMutate.mockImplementation((_code, options) => {
      options.onError(
        new Error(
          'secretOrPrivateKey must be an asymmetric key when using RS256',
        ),
      );
    });
    searchParams = new URLSearchParams({
      code: 'manifest-code',
      state: encodeRecord({
        mode: 'github-app-manifest',
        redirect: '/setup?step=source-control-connect',
      }),
    });

    render(<Page />);

    const returnButton = await screen.findByRole('button', {
      name: 'Review GitHub configuration',
    });
    fireEvent.click(returnButton);

    // Full document navigation so the setup wizard reads the ?step= deep
    // link on a fresh load instead of racing a client-side transition.
    expect(assignMock).toHaveBeenCalledWith(
      '/setup?step=source-control-config',
    );
    expect(mockPush).not.toHaveBeenCalled();

    Object.defineProperty(window, 'location', {
      configurable: true,
      value: originalLocation,
    });
  });

  it('sends non-setup errors to settings', async () => {
    const originalLocation = window.location;
    const assignMock = vi.fn();

    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalLocation, assign: assignMock },
    });

    searchParams = new URLSearchParams({
      state: encodeRecord({ mode: 'github-app-manifest' }),
    });

    render(<Page />);

    const returnButton = await screen.findByRole('button', {
      name: 'Open settings',
    });
    fireEvent.click(returnButton);

    expect(assignMock).toHaveBeenCalledWith('/settings');

    Object.defineProperty(window, 'location', {
      configurable: true,
      value: originalLocation,
    });
  });
});
