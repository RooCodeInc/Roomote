import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';

const { roomoteWordmarkMock } = vi.hoisted(() => ({
  roomoteWordmarkMock: vi.fn(({ className }: { className?: string }) => (
    <div data-wordmark-class-name={className}>RoomoteWordmark</div>
  )),
}));

vi.mock('@/components/layout', () => ({
  PreSessionBackdrop: ({ children }: { children: ReactNode }) => (
    <div data-testid="pre-session-backdrop">{children}</div>
  ),
  RoomoteWordmark: roomoteWordmarkMock,
}));

import Layout from './layout';

describe('Unauthenticated layout', () => {
  beforeEach(() => {
    roomoteWordmarkMock.mockClear();
  });

  it('renders the logged-out shell in the setup-style centered frame', () => {
    render(
      <Layout>
        <div>child</div>
      </Layout>,
    );

    expect(screen.getByText('RoomoteWordmark')).toBeInTheDocument();
    expect(screen.getByText('child')).toBeInTheDocument();
    expect(screen.getByTestId('pre-session-backdrop')).toBeInTheDocument();

    const contentColumn = screen.getByText('RoomoteWordmark').parentElement;
    expect(contentColumn).toHaveClass(
      'flex',
      'w-full',
      'flex-col',
      'md:my-auto',
    );

    const centeredShell = contentColumn?.parentElement;
    expect(centeredShell).toHaveClass('relative', 'max-w-3xl', 'md:min-h-full');
    expect(centeredShell?.firstElementChild).toHaveClass(
      'absolute',
      'inset-y-0',
      'left-0',
      'border-l-2',
      'border-dotted',
    );
    expect(screen.getByText('RoomoteWordmark')).toHaveAttribute(
      'data-wordmark-class-name',
      expect.stringContaining('mb-8'),
    );
  });
});
