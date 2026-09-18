import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';

import { encodeRecord } from '@/lib';

const { framedSurfaceMock } = vi.hoisted(() => ({
  framedSurfaceMock: vi.fn(
    ({
      children,
      frameClassName,
      surfaceClassName,
      variant,
    }: {
      children: ReactNode;
      frameClassName?: string;
      surfaceClassName?: string;
      variant?: string;
    }) => (
      <div
        data-frame-class-name={frameClassName}
        data-surface-class-name={surfaceClassName}
        data-variant={variant}
      >
        {children}
      </div>
    ),
  ),
}));

const state = vi.hoisted(() => ({
  pathname: '/some-route',
  searchParams: new URLSearchParams(),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => state.pathname,
  useSearchParams: () => state.searchParams,
}));

vi.mock('@/components/layout', () => ({
  FramedSurface: framedSurfaceMock,
  UserMenu: () => <div>UserMenu</div>,
}));

import Layout from './layout';

/**
 * Mirrors the `<base64url payload>.<signature>` shape produced by
 * createSignedGitHubAuthState; the layout never verifies the signature.
 */
function encodeSignedStyleState(payload: Record<string, unknown>): string {
  const encoded = btoa(JSON.stringify(payload))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/u, '');
  return `${encoded}.signature`;
}

describe('Centered layout', () => {
  beforeEach(() => {
    framedSurfaceMock.mockClear();
    state.pathname = '/some-route';
    state.searchParams = new URLSearchParams();
  });

  it('renders the centered shell at full effective viewport height', () => {
    render(
      <Layout>
        <div>child</div>
      </Layout>,
    );

    expect(screen.getByText('UserMenu')).toBeInTheDocument();
    expect(screen.getByText('child')).toBeInTheDocument();

    expect(framedSurfaceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        variant: 'basic',
        frameClassName: expect.stringContaining(
          'h-effective-viewport min-h-effective-viewport',
        ),
        surfaceClassName: expect.stringContaining(
          'relative flex items-center justify-center',
        ),
      }),
      undefined,
    );
  });

  it('uses the basic framed surface when the callback requests the regular background', () => {
    state.searchParams = new URLSearchParams('bg=background');

    render(
      <Layout>
        <div>child</div>
      </Layout>,
    );

    expect(framedSurfaceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        variant: 'basic',
      }),
      undefined,
    );
  });

  it('reads the background hint from a signed account-link state', () => {
    state.searchParams = new URLSearchParams({
      state: encodeSignedStyleState({
        mode: 'auth',
        redirect: '/settings',
        bg: 'accent',
      }),
    });

    render(
      <Layout>
        <div>child</div>
      </Layout>,
    );

    expect(framedSurfaceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        variant: 'bold',
      }),
      undefined,
    );
  });

  it('uses the bold framed surface for setup-originated signed states', () => {
    state.searchParams = new URLSearchParams({
      state: encodeSignedStyleState({
        mode: 'auth',
        redirect: '/setup?step=source-control-config',
      }),
    });

    render(
      <Layout>
        <div>child</div>
      </Layout>,
    );

    expect(framedSurfaceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        variant: 'bold',
      }),
      undefined,
    );
  });

  it('falls back to the basic framed surface for an unreadable state', () => {
    state.searchParams = new URLSearchParams({ state: 'not.base64.json' });

    render(
      <Layout>
        <div>child</div>
      </Layout>,
    );

    expect(framedSurfaceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        variant: 'basic',
      }),
      undefined,
    );
  });

  it('uses the bold framed surface for setup-originated callbacks', () => {
    state.searchParams = new URLSearchParams({
      state: encodeRecord({ redirect: '/setup?step=github' }),
    });

    render(
      <Layout>
        <div>child</div>
      </Layout>,
    );

    expect(framedSurfaceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        variant: 'bold',
      }),
      undefined,
    );
  });

  it('uses the bold framed surface for onboarding-originated callbacks', () => {
    state.searchParams = new URLSearchParams({
      state: encodeRecord({ redirect: '/onboarding?step=github' }),
    });

    render(
      <Layout>
        <div>child</div>
      </Layout>,
    );

    expect(framedSurfaceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        variant: 'bold',
      }),
      undefined,
    );
  });
});
