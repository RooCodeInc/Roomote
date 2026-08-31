import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';

const { releaseNotesDialogMock, useQueryMock } = vi.hoisted(() => ({
  releaseNotesDialogMock: vi.fn(),
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
    DropdownMenuItem: ({
      children,
      onClick,
    }: {
      children: ReactNode;
      onClick?: () => void;
    }) => (
      <div data-slot="dropdown-menu-item" onClick={onClick}>
        {children}
      </div>
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

vi.mock('@/components/layout/release-notices/ReleaseNotesDialog', () => ({
  ReleaseNotesDialog: (props: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    mode: string;
    version: string;
  }) => {
    releaseNotesDialogMock(props);
    return props.open ? <div data-testid="release-notes-dialog" /> : null;
  },
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
    releaseNotesDialogMock.mockClear();
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

  it('disables release history until a version is available', () => {
    render(<UserMenu />);

    fireEvent.click(screen.getByText('About Roomote'));
    const releasesButton = screen.getByRole('button', {
      name: 'See all Roomote releases',
    });

    expect(releasesButton).toBeDisabled();
    fireEvent.click(releasesButton);
    expect(releaseNotesDialogMock).not.toHaveBeenCalled();
    expect(
      screen.getByRole('heading', { name: 'About Roomote' }),
    ).toBeInTheDocument();
  });

  it('opens release history with the running version and closes About Roomote', () => {
    useQueryMock.mockReturnValue({
      data: {
        displayVersion: 'main-12345678',
        runningVersion: '0.46.0',
      },
    });
    render(<UserMenu />);

    fireEvent.click(screen.getByText('About Roomote'));
    expect(
      screen.getByRole('heading', { name: 'About Roomote' }),
    ).toBeInTheDocument();

    const releasesButton = screen.getByRole('button', {
      name: 'See all Roomote releases',
    });
    expect(releasesButton).toBeEnabled();
    expect(
      screen.queryByRole('link', { name: 'See all Roomote releases' }),
    ).not.toBeInTheDocument();
    fireEvent.click(releasesButton);

    expect(
      screen.queryByRole('heading', { name: 'About Roomote' }),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId('release-notes-dialog')).toBeInTheDocument();
    expect(releaseNotesDialogMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        mode: 'whats-new',
        open: true,
        version: '0.46.0',
      }),
    );
  });

  it('falls back to the display version for release history', () => {
    useQueryMock.mockReturnValue({
      data: {
        displayVersion: '0.45.1',
        runningVersion: null,
      },
    });
    render(<UserMenu />);

    fireEvent.click(screen.getByText('About Roomote'));
    fireEvent.click(
      screen.getByRole('button', { name: 'See all Roomote releases' }),
    );

    expect(releaseNotesDialogMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ version: '0.45.1' }),
    );
  });
});
