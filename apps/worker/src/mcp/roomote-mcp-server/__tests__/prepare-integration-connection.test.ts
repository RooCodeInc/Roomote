const mocks = vi.hoisted(() => ({ createClient: vi.fn(), query: vi.fn() }));
vi.mock('@roomote/sdk/client', () => ({ createClient: mocks.createClient }));

import { handlePrepareIntegrationConnection } from '../prepare-integration-connection.js';

it('uses the authenticated SDK query and passes only provider input', async () => {
  mocks.createClient.mockReturnValue({
    mcpConnections: { prepareConnection: { query: mocks.query } },
  });
  mocks.query.mockResolvedValue({ status: 'setup_required', validated: false });
  const result = await handlePrepareIntegrationConnection(
    { provider: 'Example' },
    { platformApiUrl: 'https://roomote.example', token: 'test-token' },
  );
  expect(mocks.query).toHaveBeenCalledWith({ provider: 'Example' });
  expect(mocks.createClient).toHaveBeenCalledWith({
    url: 'https://roomote.example',
    headers: expect.any(Function),
  });
  expect(result.content).toEqual([
    { type: 'text', text: expect.stringContaining('setup_required') },
  ]);
});
