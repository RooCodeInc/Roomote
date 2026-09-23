import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PendingIntegrationToolApprovals } from '@/components/sessions/PendingIntegrationToolApprovals';
import { useSessionIntegrationToolApprovals } from './useSessionIntegrationToolApprovals';

function PendingView() {
  const { data } = useSessionIntegrationToolApprovals('session-1', true);
  return (
    <PendingIntegrationToolApprovals
      sessionId="session-1"
      pending={data?.pending ?? []}
    />
  );
}

it('removes the web approval after a provider decides it and the query refetches', async () => {
  let pending = [
    {
      approvalId: '3f0c8f0e-1111-4222-8333-444455556666',
      integrationId: 'example',
      toolName: 'write',
      argsSummary: {},
      status: 'pending',
      taskId: null,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      createdAt: new Date().toISOString(),
    },
  ];
  const fetchMock = vi.fn(
    async () => new Response(JSON.stringify({ pending }), { status: 200 }),
  );
  vi.stubGlobal('fetch', fetchMock);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  try {
    render(
      <QueryClientProvider client={client}>
        <PendingView />
      </QueryClientProvider>,
    );
    await screen.findByTestId('pending-tool-approvals');
    // The provider callback commits the decision on the same database row.
    pending = [];
    await client.invalidateQueries({
      queryKey: ['session-integration-tool-approvals', 'session-1'],
    });
    await waitFor(() =>
      expect(screen.queryByTestId('pending-tool-approvals')).toBeNull(),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  } finally {
    vi.unstubAllGlobals();
    client.clear();
  }
});
