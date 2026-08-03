import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { render, screen } from '@testing-library/react';

const { useQueryMock } = vi.hoisted(() => ({
  useQueryMock: vi.fn(),
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: useQueryMock,
}));

vi.mock('@/components/system', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/system')>();

  return {
    ...actual,
    DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
    DropdownMenuContent: ({ children }: { children: ReactNode }) => (
      <div>{children}</div>
    ),
    DropdownMenuItem: ({ children }: { children: ReactNode }) => (
      <div data-slot="dropdown-menu-item">{children}</div>
    ),
    DropdownMenuSeparator: () => <hr />,
    DropdownMenuTrigger: ({
      children,
      ...props
    }: ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode }) => (
      <button type="button" {...props}>
        {children}
      </button>
    ),
  };
});

vi.mock('@/hooks/useUser', () => ({
  useUser: () => ({
    isSignedIn: true,
    user: {
      name: 'Ada Lovelace',
      primaryEmail: 'ada@example.com',
      resource: {
        imageUrl: null,
        primaryEmailAddress: { emailAddress: 'ada@example.com' },
      },
    },
  }),
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    releases: {
      status: {
        queryOptions: vi.fn(() => ({ queryKey: ['releases.status'] })),
      },
    },
  }),
}));

import { UserMenu } from './UserMenu';

describe('UserMenu', () => {
  beforeEach(() => {
    useQueryMock.mockReturnValue({ data: null });
  });

  it('links to personal settings from the user summary', () => {
    render(<UserMenu />);

    const settingsLink = screen.getByRole('link', {
      name: 'Personal settings',
    });

    expect(settingsLink).toHaveAttribute('href', '/settings/personal');
    expect(
      settingsLink.closest('[data-slot="dropdown-menu-item"]'),
    ).toBeInTheDocument();
  });

  it('hides personal settings while setup is incomplete', () => {
    render(<UserMenu showPersonalSettings={false} />);

    expect(
      screen.queryByRole('link', { name: 'Personal settings' }),
    ).not.toBeInTheDocument();
  });
});
