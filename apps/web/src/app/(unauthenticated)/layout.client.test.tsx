import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';

const { framedSurfaceMock, roomoteWordmarkMock } = vi.hoisted(() => ({
  framedSurfaceMock: vi.fn(
    ({
      children,
      frameClassName,
      surfaceClassName,
      variant,
      style,
    }: {
      children: ReactNode;
      frameClassName?: string;
      surfaceClassName?: string;
      variant?: string;
      style?: React.CSSProperties;
    }) => (
      <div
        data-frame-class-name={frameClassName}
        data-surface-class-name={surfaceClassName}
        data-variant={variant}
        data-height={style?.height}
        data-min-height={style?.minHeight}
      >
        {children}
      </div>
    ),
  ),
  roomoteWordmarkMock: vi.fn(({ className }: { className?: string }) => (
    <div data-wordmark-class-name={className}>RoomoteWordmark</div>
  )),
}));

vi.mock('@/components/layout', () => ({
  FramedSurface: framedSurfaceMock,
  RoomoteWordmark: roomoteWordmarkMock,
}));

import Layout from './layout';

describe('Unauthenticated layout', () => {
  beforeEach(() => {
    framedSurfaceMock.mockClear();
    roomoteWordmarkMock.mockClear();
  });

  it('renders the logged-out shell at full effective viewport height', () => {
    render(
      <Layout>
        <div>child</div>
      </Layout>,
    );

    expect(screen.getByText('RoomoteWordmark')).toBeInTheDocument();
    expect(screen.getByText('child')).toBeInTheDocument();

    expect(framedSurfaceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        variant: 'bold',
        frameClassName: expect.stringContaining('items-center justify-center'),
        surfaceClassName: expect.stringContaining(
          'light flex items-center justify-center text-foreground',
        ),
        style: expect.objectContaining({
          height: 'var(--effective-viewport-height)',
          minHeight: 'var(--effective-viewport-height)',
        }),
      }),
      undefined,
    );
    expect(screen.getByText('RoomoteWordmark').parentElement).toHaveClass(
      'flex',
      'max-h-full',
      'gap-8',
      'overflow-y-auto',
    );
    expect(screen.getByText('RoomoteWordmark')).toHaveAttribute(
      'data-wordmark-class-name',
      expect.stringContaining('shrink-0'),
    );
  });
});
