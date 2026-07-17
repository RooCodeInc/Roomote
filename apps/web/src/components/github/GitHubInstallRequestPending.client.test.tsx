import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const { pendingInstallationsDataRef, resolveMutateMock, resolveOptionsRef } =
  vi.hoisted(() => ({
    pendingInstallationsDataRef: {
      current: undefined as { pending: boolean } | undefined,
    },
    resolveMutateMock: vi.fn(),
    resolveOptionsRef: {
      current: null as {
        onSuccess?: (result: {
          success: boolean;
          pending?: number;
          completed?: number;
          error?: string;
        }) => void;
        onError?: (error: Error) => void;
      } | null,
    },
  }));

vi.mock('@/hooks/github', () => ({
  useGitHubPendingInstallations: () => ({
    data: pendingInstallationsDataRef.current,
  }),
  useResolvePendingGitHubInstallations: (options: unknown) => {
    resolveOptionsRef.current = options as NonNullable<
      typeof resolveOptionsRef.current
    >;

    return { mutate: resolveMutateMock, isPending: false };
  },
}));

vi.mock('@/components/system', () => ({
  Alert: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDescription: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  Button: ({
    children,
    ...props
  }: { children: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type={props.type ?? 'button'} {...props}>
      {children}
    </button>
  ),
}));

import { GitHubInstallRequestPending } from './GitHubInstallRequestPending';

describe('GitHubInstallRequestPending', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pendingInstallationsDataRef.current = { pending: true };
    resolveOptionsRef.current = null;
  });

  it('calls onApproved once when polling reports the request is no longer pending', async () => {
    const onApproved = vi.fn();
    pendingInstallationsDataRef.current = { pending: false };

    render(<GitHubInstallRequestPending onApproved={onApproved} />);

    await waitFor(() => expect(onApproved).toHaveBeenCalledTimes(1));
  });

  it('does not call onApproved while the request is still pending', () => {
    const onApproved = vi.fn();

    render(<GitHubInstallRequestPending onApproved={onApproved} />);

    expect(onApproved).not.toHaveBeenCalled();
    expect(screen.getByText(/pending approval/i)).toBeInTheDocument();
  });

  it('resolves on demand and advances when a request completes', () => {
    const onApproved = vi.fn();

    render(<GitHubInstallRequestPending onApproved={onApproved} />);

    fireEvent.click(screen.getByRole('button', { name: /Check now/i }));
    expect(resolveMutateMock).toHaveBeenCalledTimes(1);

    resolveOptionsRef.current?.onSuccess?.({
      success: true,
      pending: 0,
      completed: 1,
    });

    expect(onApproved).toHaveBeenCalledTimes(1);
  });

  it('surfaces a not-approved-yet message when the manual check finds nothing', async () => {
    const onApproved = vi.fn();

    render(<GitHubInstallRequestPending onApproved={onApproved} />);

    fireEvent.click(screen.getByRole('button', { name: /Check now/i }));
    resolveOptionsRef.current?.onSuccess?.({
      success: true,
      pending: 1,
      completed: 0,
    });

    await waitFor(() =>
      expect(screen.getByText(/Not approved yet/i)).toBeInTheDocument(),
    );
    expect(onApproved).not.toHaveBeenCalled();
  });

  it('renders the provided footer', () => {
    render(
      <GitHubInstallRequestPending
        onApproved={vi.fn()}
        footer={<span>footer-slot</span>}
      />,
    );

    expect(screen.getByText('footer-slot')).toBeInTheDocument();
  });
});
