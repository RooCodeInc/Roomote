// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { notifyIntegrationKeysChanged } from './integration-key-dialog';
import { PendingIntegrationKeys } from './PendingIntegrationKeys';

const refetch = vi.fn();
const state: {
  pending: unknown[];
  hasData: boolean;
  error: Error | null;
  isFetching: boolean;
} = { pending: [], hasData: true, error: null, isFetching: false };

vi.mock('@/hooks/useSessionIntegrationApprovals', () => ({
  useSessionIntegrationApprovals: () => ({
    data: state.hasData ? { pending: state.pending, secrets: [] } : undefined,
    error: state.error,
    isFetching: state.isFetching,
    refetch,
  }),
}));

const demo = {
  pendingRef: '6a1f8f1e-0000-4000-8000-000000000007',
  label: 'Figma',
  origin: 'https://api.figma.com',
  headerName: 'x-figma-token',
  headerPrefix: '',
  allowedMethods: ['GET', 'HEAD'],
  lifetimeHours: null,
  expiresAt: new Date(Date.now() + 3600000).toISOString(),
  createdAt: new Date().toISOString(),
};

describe('PendingIntegrationKeys', () => {
  it('renders nothing without pending approvals', () => {
    state.pending = [];
    const { container } = render(
      <PendingIntegrationKeys sessionId="s1" latestRequestId={null} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('shows a retryable error when the initial load fails', () => {
    state.hasData = false;
    state.error = new Error('Unavailable');
    render(<PendingIntegrationKeys sessionId="s1" latestRequestId={null} />);

    expect(
      screen.getByText('Failed to load pending integration keys.'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetch).toHaveBeenCalledOnce();
  });

  it('disables retry while the initial load is fetching', () => {
    state.hasData = false;
    state.error = new Error('Unavailable');
    state.isFetching = true;
    render(<PendingIntegrationKeys sessionId="s1" latestRequestId={null} />);

    expect(screen.getByRole('button', { name: 'Retry' })).toBeDisabled();
  });

  it('shows one card per pending approval and opens the dialog fragment', () => {
    state.pending = [demo];
    window.location.hash = '';
    render(<PendingIntegrationKeys sessionId="s1" latestRequestId="req-1" />);
    expect(screen.getByText('Add your Figma key')).toBeInTheDocument();
    expect(
      screen.getByText('https://api.figma.com · GET, HEAD'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Enter key' }));
    expect(window.location.hash).toBe('#integrations');
    expect(refetch).toHaveBeenCalled();
  });

  it('keeps cached pending approvals visible after a refetch fails', () => {
    state.pending = [demo];
    state.error = new Error('Unavailable');
    render(<PendingIntegrationKeys sessionId="s1" latestRequestId={null} />);

    expect(screen.getByText('Add your Figma key')).toBeInTheDocument();
    expect(
      screen.queryByText('Failed to load pending integration keys.'),
    ).not.toBeInTheDocument();
  });

  it('refetches after a key is saved', () => {
    state.pending = [demo];
    refetch.mockClear();
    render(<PendingIntegrationKeys sessionId="s1" latestRequestId={null} />);
    notifyIntegrationKeysChanged();
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('refetches once the soonest approval expires', () => {
    vi.useFakeTimers();
    try {
      state.pending = [
        { ...demo, expiresAt: new Date(Date.now() + 5_000).toISOString() },
      ];
      refetch.mockClear();
      render(<PendingIntegrationKeys sessionId="s1" latestRequestId={null} />);
      vi.advanceTimersByTime(5_500);
      expect(refetch).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1_000);
      expect(refetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

afterEach(() => {
  state.pending = [];
  state.hasData = true;
  state.error = null;
  state.isFetching = false;
  refetch.mockClear();
});
