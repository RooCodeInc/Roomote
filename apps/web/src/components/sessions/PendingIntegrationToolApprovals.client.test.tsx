import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import type { IntegrationToolApprovalMetadata } from '@roomote/types';

import { PendingIntegrationToolApprovals } from './PendingIntegrationToolApprovals';

const pending: IntegrationToolApprovalMetadata[] = [
  {
    approvalId: '3f0c8f0e-1111-4222-8333-444455556666',
    integrationId: 'mock-slack',
    toolName: 'post_message',
    argsSummary: { channel: 'C1' },
    status: 'pending',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    createdAt: new Date().toISOString(),
  },
];

describe('PendingIntegrationToolApprovals', () => {
  const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));

  beforeEach(() => {
    fetchMock.mockClear();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function renderCard() {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <PendingIntegrationToolApprovals
          sessionId="session-1"
          pending={pending}
        />
      </QueryClientProvider>,
    );
  }

  it.each([
    ['Allow once', 'approved'],
    ["Don't ask again this session", 'approved_for_session'],
    ['Reject', 'rejected'],
  ])('submits "%s" as the %s decision', async (label, decision) => {
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: label }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe('/api/sessions/session-1/integration-tool-approvals');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      approvalId: pending[0]!.approvalId,
      decision,
    });
  });
});
