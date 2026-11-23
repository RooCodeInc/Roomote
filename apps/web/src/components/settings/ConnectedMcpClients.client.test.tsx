import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { ConnectedMcpClients } from './ConnectedMcpClients';

const mocks = vi.hoisted(() => ({ revoke: vi.fn(), revokeAll: vi.fn() }));
const grants = [
  { grantId: 'a'.repeat(64), clientName: 'Editor', status: 'active' },
  { grantId: 'b'.repeat(64), clientName: 'Desktop', status: 'pending' },
].map((grant) => ({
  ...grant,
  authorizedAt: null,
  expiresAt: 1_900_000_000,
  lastUsedAt: null,
  lastTokenAt: null,
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    mcpAuthorizations: {
      list: {
        queryKey: () => ['mcpAuthorizations', 'list'],
        queryOptions: () => ({
          queryKey: ['mcpAuthorizations', 'list'],
          queryFn: async () => grants,
        }),
      },
      revoke: {
        mutationOptions: (options: object) => ({
          ...options,
          mutationFn: mocks.revoke,
        }),
      },
      revokeAll: {
        mutationOptions: (options: object) => ({
          ...options,
          mutationFn: mocks.revokeAll,
        }),
      },
    },
  }),
}));

function renderClients(userId?: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ConnectedMcpClients userId={userId} />
    </QueryClientProvider>,
  );
}

describe('Connected MCP client action identity', () => {
  beforeEach(() => {
    mocks.revoke.mockReset().mockResolvedValue({ success: true });
    mocks.revokeAll.mockReset().mockResolvedValue({ success: true });
  });

  it.each([undefined, 'managed-user'])(
    'identifies each revoke action and keeps the chosen grant target for %s',
    async (userId) => {
      renderClients(userId);

      const editor = await screen.findByRole('button', {
        name: 'Revoke Editor',
      });
      const desktop = screen.getByRole('button', { name: 'Revoke Desktop' });
      expect(editor).toHaveTextContent(/^Revoke$/);
      expect(desktop).toHaveTextContent(/^Revoke$/);

      fireEvent.click(editor);
      let dialog = screen.getByRole('dialog', { name: 'Revoke Editor?' });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      expect(mocks.revoke).not.toHaveBeenCalled();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

      fireEvent.click(desktop);
      dialog = screen.getByRole('dialog', { name: 'Revoke Desktop?' });
      fireEvent.click(
        within(dialog).getByRole('button', { name: 'Revoke access' }),
      );
      await waitFor(() =>
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
      );
      expect(mocks.revoke.mock.calls[0]?.[0]).toEqual({
        userId,
        grantId: grants[1]!.grantId,
      });
      expect(mocks.revokeAll).not.toHaveBeenCalled();
    },
  );
});
