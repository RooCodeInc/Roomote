// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { PendingIntegrationKeys } from './PendingIntegrationKeys';

const refetch = vi.fn();
const state: { pending: unknown[] } = { pending: [] };

vi.mock('@/hooks/useSessionIntegrationApprovals', () => ({
  useSessionIntegrationApprovals: () => ({
    data: { pending: state.pending, secrets: [] },
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

  it('refetches when the dialog fragment changes', () => {
    state.pending = [demo];
    refetch.mockClear();
    render(<PendingIntegrationKeys sessionId="s1" latestRequestId={null} />);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});
