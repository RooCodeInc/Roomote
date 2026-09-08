const { mutate } = vi.hoisted(() => ({ mutate: vi.fn() }));
vi.mock('@roomote/sdk/client', () => ({
  workerClient: { mcpConnections: { manageConnection: { mutate } } },
}));
import { handleManageIntegrationConnection } from '../manage-integration-connection.js';

it('calls the authenticated typed worker client and preserves service state', async () => {
  mutate.mockResolvedValueOnce({
    state: 'auth_pending',
    integrationId: 'custom:1',
  });
  const result = await handleManageIntegrationConnection({
    action: 'request_auth',
    integrationId: 'custom:1',
  });
  expect(mutate).toHaveBeenCalledWith({
    action: 'request_auth',
    integrationId: 'custom:1',
  });
  expect(JSON.stringify(result)).toContain('auth_pending');
});

it('does not echo upstream errors or credentials', async () => {
  mutate.mockRejectedValueOnce(
    new Error('https://user:secret@host?token=secret'),
  );
  const result = await handleManageIntegrationConnection({ action: 'list' });
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result)).not.toContain('secret');
});
