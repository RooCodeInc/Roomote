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
