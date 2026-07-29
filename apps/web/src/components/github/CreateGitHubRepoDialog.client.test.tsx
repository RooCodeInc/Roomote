import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SVGProps,
} from 'react';
import { fireEvent, render, screen } from '@testing-library/react';

type RepositoryRow = {
  id: string;
  fullName: string;
  sourceControlProvider: string;
  isEmpty?: boolean;
};

const {
  mockEnableGitHubApp,
  mockSyncGitHubInstallations,
  mockUserState,
  mockInstallationsState,
  mockRepositoriesState,
  mockToast,
} = vi.hoisted(() => ({
  mockEnableGitHubApp: vi.fn(),
  mockSyncGitHubInstallations: vi.fn(),
  mockUserState: { isAdmin: true as boolean },
  mockInstallationsState: {
    data: [] as Array<{
      id: string;
      accountLogin: string;
      accountType: string;
      suspendedAt: string | null;
    }>,
  },
  mockRepositoriesState: { data: [] as RepositoryRow[] },
  mockToast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/settings/environments/new',
  useSearchParams: () => new URLSearchParams(''),
}));

vi.mock('sonner', () => ({ toast: mockToast }));

vi.mock('@/hooks/github', () => ({
  useEnableGitHubApp: () => ({
    mutate: mockEnableGitHubApp,
    isPending: false,
  }),
  useGitHubInstallations: () => ({ data: mockInstallationsState.data }),
  useSyncGitHubInstallations: () => ({
    mutate: mockSyncGitHubInstallations,
    isPending: false,
  }),
}));

vi.mock('@/hooks/source-control', () => ({
  useRepositories: () => ({ data: mockRepositoriesState.data }),
}));

vi.mock('@/hooks/useRealtimePolling', () => ({
  useRealtimePolling: () => ({
    refetchInterval: false,
    refetchIntervalInBackground: false,
    retry: 3,
    isVisible: true,
  }),
}));

vi.mock('@/hooks/useUser', () => ({
  useAuthorizedUser: () => ({ isAdmin: mockUserState.isAdmin }),
}));

vi.mock('@/components/system', () => {
  const passthrough = (Tag: 'div' | 'p' | 'span' | 'label' = 'div') => {
    const Passthrough = ({ children, ...props }: { children?: ReactNode }) => (
      <Tag {...props}>{children}</Tag>
    );
    Passthrough.displayName = `Passthrough(${Tag})`;
    return Passthrough;
  };

  return {
    Alert: passthrough(),
    AlertDescription: passthrough(),
    AlertTitle: passthrough(),
    Button: ({
      children,
      asChild: _asChild,
      ...props
    }: {
      children: ReactNode;
      asChild?: boolean;
    } & ButtonHTMLAttributes<HTMLButtonElement>) =>
      _asChild ? (
        <>{children}</>
      ) : (
        <button type={props.type ?? 'button'} {...props}>
          {children}
        </button>
      ),
    CircleCheck: (props: SVGProps<SVGSVGElement>) => <svg {...props} />,
    Dialog: ({ children, open }: { children: ReactNode; open: boolean }) =>
      open ? <div>{children}</div> : null,
    DialogContent: passthrough(),
    DialogDescription: passthrough('p'),
    DialogFooter: passthrough(),
    DialogHeader: passthrough(),
    DialogTitle: passthrough('p'),
    ExternalLink: (props: SVGProps<SVGSVGElement>) => <svg {...props} />,
    Input: (props: InputHTMLAttributes<HTMLInputElement>) => (
      <input {...props} />
    ),
    Label: passthrough('label'),
    Loader2: (props: SVGProps<SVGSVGElement>) => <svg {...props} />,
    Pencil: (props: SVGProps<SVGSVGElement>) => <svg {...props} />,
    Plus: (props: SVGProps<SVGSVGElement>) => <svg {...props} />,
    Select: passthrough(),
    SelectContent: passthrough(),
    SelectItem: passthrough(),
    SelectTrigger: passthrough(),
    SelectValue: passthrough('span'),
    RadioGroup: ({
      children,
      onValueChange,
      ...props
    }: {
      children: ReactNode;
      onValueChange?: (value: string) => void;
    }) => (
      <fieldset
        {...props}
        onChange={(event) => {
          if (event.target instanceof HTMLInputElement) {
            onValueChange?.(event.target.value);
          }
        }}
      >
        {children}
      </fieldset>
    ),
    RadioGroupItem: (props: InputHTMLAttributes<HTMLInputElement>) => (
      <input type="radio" {...props} />
    ),
  };
});

import { CreateGitHubRepoDialog } from './CreateGitHubRepoDialog';

function findLinkByText(text: RegExp): HTMLAnchorElement {
  const link = screen
    .getAllByRole('link')
    .find((element) => text.test(element.textContent ?? ''));

  if (!link) {
    throw new Error(`No link matching ${text}`);
  }

  return link as HTMLAnchorElement;
}

describe('CreateGitHubRepoDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUserState.isAdmin = true;
    mockInstallationsState.data = [
      {
        id: 'install-1',
        accountLogin: 'acme',
        accountType: 'Organization',
        suspendedAt: null,
      },
    ];
    mockRepositoriesState.data = [
      {
        id: 'repo-1',
        fullName: 'acme/existing',
        sourceControlProvider: 'github',
      },
    ];
  });

  it('prefills the github.com/new link with the installation owner', () => {
    render(
      <CreateGitHubRepoDialog open={true} onOpenChange={() => undefined} />,
    );

    expect(findLinkByText(/^Go$/).getAttribute('href')).toBe(
      'https://github.com/new?owner=acme',
    );
  });

  it('falls back to a bare github.com/new link without installations', () => {
    mockInstallationsState.data = [];

    render(
      <CreateGitHubRepoDialog open={true} onOpenChange={() => undefined} />,
    );

    expect(findLinkByText(/^Go$/).getAttribute('href')).toBe(
      'https://github.com/new',
    );
  });

  it('builds the fork link from a pasted repository URL', () => {
    render(
      <CreateGitHubRepoDialog open={true} onOpenChange={() => undefined} />,
    );

    fireEvent.click(screen.getByRole('radio', { name: 'Fork existing' }));

    fireEvent.change(screen.getByLabelText('Repository to fork'), {
      target: { value: 'https://github.com/RooCodeInc/Roomote' },
    });

    expect(findLinkByText(/Open GitHub fork page/).getAttribute('href')).toBe(
      'https://github.com/RooCodeInc/Roomote/fork',
    );
  });

  it('shows a validation hint for unparseable fork references', () => {
    render(
      <CreateGitHubRepoDialog open={true} onOpenChange={() => undefined} />,
    );

    fireEvent.click(screen.getByRole('radio', { name: 'Fork existing' }));

    fireEvent.change(screen.getByLabelText('Repository to fork'), {
      target: { value: 'https://gitlab.com/acme/repo' },
    });

    expect(
      screen.getByText('Enter a GitHub repository URL or owner/repo.'),
    ).toBeInTheDocument();
  });

  it('surfaces repositories that appear after the dialog opened', () => {
    const onRepositoryDetected = vi.fn();
    const { rerender } = render(
      <CreateGitHubRepoDialog
        open={true}
        onOpenChange={() => undefined}
        onRepositoryDetected={onRepositoryDetected}
      />,
    );

    expect(screen.queryByText(/Found /)).not.toBeInTheDocument();

    mockRepositoriesState.data = [
      ...mockRepositoriesState.data,
      {
        id: 'repo-2',
        fullName: 'acme/new-repo',
        sourceControlProvider: 'github',
        isEmpty: true,
      },
    ];

    rerender(
      <CreateGitHubRepoDialog
        open={true}
        onOpenChange={() => undefined}
        onRepositoryDetected={onRepositoryDetected}
      />,
    );

    expect(screen.getByText('Found acme/new-repo')).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', { name: 'Use this repository' }),
    );

    expect(onRepositoryDetected).toHaveBeenCalledWith({
      id: 'repo-2',
      fullName: 'acme/new-repo',
      isEmpty: true,
    });
  });

  it('triggers a manual GitHub sync from the refresh link', () => {
    render(
      <CreateGitHubRepoDialog open={true} onOpenChange={() => undefined} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Refresh now' }));

    expect(mockSyncGitHubInstallations).toHaveBeenCalledTimes(1);
  });

  it('offers the Update GitHub action to admins only', () => {
    const { unmount } = render(
      <CreateGitHubRepoDialog open={true} onOpenChange={() => undefined} />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Update GitHub/i }));
    expect(mockEnableGitHubApp).toHaveBeenCalledWith(
      {
        redirect: '/settings/environments/new',
        callbackBackground: 'background',
      },
      expect.any(Object),
    );

    unmount();
    mockUserState.isAdmin = false;

    render(
      <CreateGitHubRepoDialog open={true} onOpenChange={() => undefined} />,
    );

    expect(screen.getByText(/Ask an admin/i)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Update GitHub/i }),
    ).not.toBeInTheDocument();
  });
});
