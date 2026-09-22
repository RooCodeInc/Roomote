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
    taskId: null,
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
    ['Allow for this session', 'approved_for_session'],
    ['Deny', 'rejected'],
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

  it('keeps technical request details collapsed until requested', () => {
    renderCard();

    expect(
      screen.getByText('Let Mock Slack use this tool?'),
    ).toBeInTheDocument();
    expect(screen.queryByText('post_message')).not.toBeInTheDocument();
    expect(screen.queryByText('mock-slack')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Details' }));

    expect(screen.getByText('post_message')).toBeInTheDocument();
    expect(screen.getByText('mock-slack')).toBeInTheDocument();
    expect(screen.getByText(/"channel": "C1"/)).toBeInTheDocument();
  });

  it('uses request context when a read tool clearly targets a repository', () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <PendingIntegrationToolApprovals
          sessionId="session-1"
          pending={[
            {
              ...pending[0]!,
              integrationId: 'deepwiki',
              toolName: 'read_wiki_structure',
              argsSummary: { repoName: 'RooCodeInc/Roomote' },
            },
          ]}
        />
      </QueryClientProvider>,
    );

    expect(
      screen.getByText('Let Deepwiki inspect this repository?'),
    ).toBeInTheDocument();
  });

  it('disables every decision while the request is being submitted', async () => {
    let resolveFetch: ((response: Response) => void) | undefined;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    renderCard();

    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Allow once' })).toBeDisabled();
      expect(
        screen.getByRole('button', { name: 'Allow for this session' }),
      ).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Deny' })).toBeDisabled();
    });

    resolveFetch?.(new Response('{}', { status: 200 }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Allow once' })).toBeEnabled();
    });
  });

  it('describes empty arguments without exposing implementation wording', () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <PendingIntegrationToolApprovals
          sessionId="session-1"
          pending={[{ ...pending[0]!, argsSummary: {} }]}
        />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Details' }));

    expect(screen.getByText('No additional details.')).toBeInTheDocument();
    expect(screen.queryByText('No arguments')).not.toBeInTheDocument();
  });
});
