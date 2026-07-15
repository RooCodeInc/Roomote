import type {
  AnchorHTMLAttributes,
  ButtonHTMLAttributes,
  HTMLAttributes,
  InputHTMLAttributes,
  LabelHTMLAttributes,
  MouseEvent,
  ReactElement,
  ReactNode,
  SVGProps,
  TextareaHTMLAttributes,
} from 'react';
import {
  cloneElement,
  createContext,
  isValidElement,
  useContext,
  useState,
} from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FeatureFlag } from '@roomote/feature-flags';

import { mockFeatureFlags } from '@/lib/mock-utils';

const state = vi.hoisted(() => ({
  featureFlags: {} as Record<FeatureFlag, boolean>,
  createSnapshot: vi.fn().mockResolvedValue({ success: true }),
  clearSnapshot: vi.fn(),
  repositories: [{ id: 'repo-1', fullName: 'acme/api' }],
  environments: [
    {
      id: 'env-1',
      name: 'Main Environment',
      description: 'Main Environment description',
      config: {
        version: 1,
        name: 'Main Environment',
        repositories: [{ repository: 'acme/api' }],
        agentInstructions: 'Keep tests green.',
      },
      snapshots: {
        modal: {
          provider: 'modal',
          snapshotId: 'snap-1',
          snapshotStatus: 'ready',
          snapshotCreatedAt: new Date('2026-03-25T09:00:00.000Z'),
          snapshotExpiresAt: new Date('2026-03-26T09:00:00.000Z'),
        },
        e2b: {
          provider: 'e2b',
          snapshotId: null,
          snapshotStatus: null,
          snapshotCreatedAt: null,
          snapshotExpiresAt: null,
        },
      },
      isVerified: true,
      verificationTaskId: 'task-verify-1',
      verificationTaskActive: true,
      verifiedAt: new Date('2026-03-25T09:00:00.000Z'),
      verificationError: null,
    },
  ],
}));

vi.mock('next/link', () => ({
  default: ({
    children,
    href,
    ...props
  }: {
    children: ReactNode;
    href: string;
  } & AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
  },
}));

vi.mock('@/hooks/useUser', () => ({
  useAuthorizedUser: () => ({
    isAdmin: true,
    featureFlags: state.featureFlags,
  }),
}));

vi.mock('@/hooks/source-control', () => ({
  useRepositories: () => ({
    data: state.repositories,
    isPending: false,
  }),
}));

vi.mock('@/hooks/environments', () => ({
  useEnvironments: () => ({
    data: state.environments,
    isPending: false,
  }),
  useDeleteEnvironment: () => ({
    isPending: false,
    variables: undefined,
    mutate: vi.fn(),
  }),
  useDuplicateEnvironment: () => ({
    isPending: false,
    mutateAsync: vi.fn(),
  }),
  useRetryEnvironmentVerification: () => ({
    isPending: false,
    variables: undefined,
    mutate: vi.fn(),
  }),
}));

vi.mock('@/hooks/snapshots', () => ({
  useCreateEnvironmentSnapshot: () => ({
    isPending: false,
    variables: undefined,
    mutateAsync: state.createSnapshot,
  }),
  useClearEnvironmentSnapshot: () => ({
    isPending: false,
    variables: undefined,
    mutate: state.clearSnapshot,
  }),
}));

function Icon(props: SVGProps<SVGSVGElement>) {
  return <svg {...props} />;
}

const CollapsibleContext = createContext<{
  open: boolean;
  setOpen: (open: boolean) => void;
} | null>(null);

vi.mock('@/components/system', () => ({
  Alert: ({
    children,
    ...props
  }: { children: ReactNode } & HTMLAttributes<HTMLDivElement>) => (
    <div {...props}>{children}</div>
  ),
  AlertCircle: Icon,
  AlertDescription: ({
    children,
    ...props
  }: { children: ReactNode } & HTMLAttributes<HTMLParagraphElement>) => (
    <p {...props}>{children}</p>
  ),
  Badge: ({
    children,
    ...props
  }: { children: ReactNode } & HTMLAttributes<HTMLSpanElement>) => (
    <span {...props}>{children}</span>
  ),
  BasicTooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  BookMarked: Icon,
  Button: ({
    children,
    asChild = false,
    ...props
  }: {
    children: ReactNode;
    asChild?: boolean;
  } & ButtonHTMLAttributes<HTMLButtonElement>) => {
    if (asChild && isValidElement(children)) {
      return cloneElement(
        children as ReactElement<Record<string, unknown>>,
        props as Record<string, unknown>,
      );
    }

    return (
      <button type={props.type ?? 'button'} {...props}>
        {children}
      </button>
    );
  },
  Camera: Icon,
  CheckCircle2: Icon,
  ChevronDown: Icon,
  Collapsible: ({
    children,
    defaultOpen = false,
    open,
    onOpenChange,
    ...props
  }: {
    children: ReactNode;
    defaultOpen?: boolean;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
  } & HTMLAttributes<HTMLDivElement>) => {
    const [internalOpen, setInternalOpen] = useState(defaultOpen);
    const isOpen = open ?? internalOpen;

    return (
      <CollapsibleContext.Provider
        value={{
          open: isOpen,
          setOpen: (nextOpen) => {
            onOpenChange?.(nextOpen);
            if (open === undefined) {
              setInternalOpen(nextOpen);
            }
          },
        }}
      >
        <div {...props} data-state={isOpen ? 'open' : 'closed'}>
          {children}
        </div>
      </CollapsibleContext.Provider>
    );
  },
  CollapsibleContent: ({
    children,
    ...props
  }: { children: ReactNode } & HTMLAttributes<HTMLDivElement>) => {
    const context = useContext(CollapsibleContext);

    if (!context?.open) {
      return null;
    }

    return <div {...props}>{children}</div>;
  },
  CollapsibleTrigger: ({
    children,
    asChild = false,
    onClick,
    ...props
  }: {
    children: ReactNode;
    asChild?: boolean;
  } & ButtonHTMLAttributes<HTMLButtonElement>) => {
    const context = useContext(CollapsibleContext);
    const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
      onClick?.(event);
      context?.setOpen(!context.open);
    };

    if (asChild && isValidElement(children)) {
      return cloneElement(
        children as ReactElement<Record<string, unknown>>,
        {
          ...props,
          onClick: handleClick,
          'data-state': context?.open ? 'open' : 'closed',
        } as Record<string, unknown>,
      );
    }

    return (
      <button
        type="button"
        {...props}
        data-state={context?.open ? 'open' : 'closed'}
        onClick={handleClick}
      >
        {children}
      </button>
    );
  },
  Copy: Icon,
  Clock: Icon,
  Dialog: ({ children, open }: { children: ReactNode; open: boolean }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({
    children,
    ...props
  }: { children: ReactNode } & HTMLAttributes<HTMLDivElement>) => (
    <div {...props}>{children}</div>
  ),
  DialogDescription: ({
    children,
    ...props
  }: { children: ReactNode } & HTMLAttributes<HTMLParagraphElement>) => (
    <p {...props}>{children}</p>
  ),
  DialogFooter: ({
    children,
    ...props
  }: { children: ReactNode } & HTMLAttributes<HTMLDivElement>) => (
    <div {...props}>{children}</div>
  ),
  DialogHeader: ({
    children,
    ...props
  }: { children: ReactNode } & HTMLAttributes<HTMLDivElement>) => (
    <div {...props}>{children}</div>
  ),
  DialogTitle: ({
    children,
    ...props
  }: { children: ReactNode } & HTMLAttributes<HTMLHeadingElement>) => (
    <h2 {...props}>{children}</h2>
  ),
  Github: Icon,
  Input: (props: InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
  Label: ({
    children,
    ...props
  }: { children: ReactNode } & LabelHTMLAttributes<HTMLLabelElement>) => (
    <label {...props}>{children}</label>
  ),
  Loader2: Icon,
  Pencil: Icon,
  Plus: Icon,
  RefreshCw: Icon,
  SearchCheck: Icon,
  Popover: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverContent: ({
    children,
    ...props
  }: { children: ReactNode } & HTMLAttributes<HTMLDivElement>) => (
    <div {...props}>{children}</div>
  ),
  PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  Settings2: Icon,
  Skeleton: (props: HTMLAttributes<HTMLDivElement>) => <div {...props} />,
  TriangleAlert: Icon,
  Textarea: (props: TextareaHTMLAttributes<HTMLTextAreaElement>) => (
    <textarea {...props} />
  ),
  Trash2: Icon,
  VectorSquare: Icon,
  X: Icon,
}));

vi.mock('@/components/layout', () => ({
  Loading: () => <span>loading</span>,
}));

vi.mock('@/components/settings', () => ({
  Section: ({
    children,
    action,
  }: {
    children: ReactNode;
    action?: ReactNode;
  }) => (
    <section>
      {action}
      {children}
    </section>
  ),
}));

vi.mock('./DuplicateEnvironmentDialog', () => ({
  DuplicateEnvironmentDialog: () => null,
}));

import { Environments } from './Environments';

describe('Environments', () => {
  beforeEach(() => {
    state.featureFlags = {
      ...mockFeatureFlags,
    };
    state.repositories = [{ id: 'repo-1', fullName: 'acme/api' }];
    state.environments = [
      {
        id: 'env-1',
        name: 'Main Environment',
        description: 'Main Environment description',
        config: {
          version: 1,
          name: 'Main Environment',
          repositories: [{ repository: 'acme/api' }],
          agentInstructions: 'Keep tests green.',
        },
        snapshots: {
          modal: {
            provider: 'modal',
            snapshotId: 'snap-1',
            snapshotStatus: 'ready',
            snapshotCreatedAt: new Date('2026-03-25T09:00:00.000Z'),
            snapshotExpiresAt: new Date('2026-03-26T09:00:00.000Z'),
          },
          e2b: {
            provider: 'e2b',
            snapshotId: null,
            snapshotStatus: null,
            snapshotCreatedAt: null,
            snapshotExpiresAt: null,
          },
        },
        isVerified: true,
        verificationTaskId: 'task-verify-1',
        verificationTaskActive: true,
        verifiedAt: new Date('2026-03-25T09:00:00.000Z'),
        verificationError: null,
      },
    ];
    state.createSnapshot.mockClear();
    state.clearSnapshot.mockClear();
  });

  it('shows a create-environment notice when there are no environments', () => {
    state.environments = [];

    render(<Environments />);

    expect(
      screen.getByText(
        /Roomote can only verify its work when running with an environment\./i,
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /add/i })).toHaveAttribute(
      'href',
      '/settings/environments/new',
    );
  });

  it('shows the setup notice when environments data is unavailable', () => {
    state.environments = undefined as unknown as typeof state.environments;

    render(<Environments />);

    expect(
      screen.getByText(
        /Roomote can only verify its work when running with an environment\./i,
      ),
    ).toBeInTheDocument();
  });

  it('shows verification and repositories while keeping snapshot details collapsed until expanded', () => {
    render(<Environments />);

    expect(screen.queryByTitle('Edit details')).not.toBeInTheDocument();
    expect(screen.getByTitle('Edit environment')).toHaveAttribute(
      'href',
      '/settings/environments/env-1/edit',
    );
    expect(
      screen.getByRole('link', { name: 'Open verification task' }),
    ).toHaveAttribute('href', '/task/task-verify-1');
    expect(
      screen.queryByRole('link', { name: 'View task' }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByTitle('Re-verify environment config'),
    ).toBeInTheDocument();
    expect(screen.getByText('acme/api')).toBeInTheDocument();
    expect(
      screen.queryByTitle('Refresh modal snapshot'),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByTitle('Toggle environment details'));

    expect(screen.getByTitle('Refresh modal snapshot')).toBeInTheDocument();
  });

  it('shows snapshot controls on the environments settings page', () => {
    render(<Environments />);

    fireEvent.click(screen.getByTitle('Toggle environment details'));

    expect(screen.getByText(/Expires /i)).toBeInTheDocument();
    expect(screen.getByTitle('Refresh modal snapshot')).toBeInTheDocument();
    expect(screen.getByTitle('Clear modal snapshot')).toBeInTheDocument();
  });

  it('shows snapshot controls for every supported provider', () => {
    render(<Environments />);

    fireEvent.click(screen.getByTitle('Toggle environment details'));

    expect(screen.getByTitle('Refresh modal snapshot')).toBeInTheDocument();
    expect(screen.getByTitle('Clear modal snapshot')).toBeInTheDocument();
    expect(screen.getByTitle('Create e2b snapshot')).toBeInTheDocument();
  });

  it('shows e2b snapshot controls', () => {
    render(<Environments />);

    fireEvent.click(screen.getByTitle('Toggle environment details'));

    expect(screen.getByText('No snapshot')).toBeInTheDocument();
    expect(screen.getByTitle('Create e2b snapshot')).toBeInTheDocument();
  });

  it('preserves the provider override for an existing non-default snapshot', async () => {
    render(<Environments />);

    fireEvent.click(screen.getByTitle('Toggle environment details'));
    fireEvent.click(screen.getByTitle('Refresh modal snapshot'));

    await waitFor(() => {
      expect(state.createSnapshot).toHaveBeenCalledWith({
        environmentId: 'env-1',
        provider: 'modal',
      });
    });
  });
});
