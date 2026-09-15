import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { SavedIntegrations } from './SavedIntegrations';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const secret = {
  secretRef: '6a1f8f1e-0000-4000-8000-000000000011',
  label: 'Stripe',
  origin: 'https://api.stripe.com',
  headerName: 'authorization',
  headerPrefix: 'Bearer ',
  allowedMethods: ['GET', 'POST'],
  scope: 'account',
  expiresAt: new Date(Date.now() + 3600000).toISOString(),
  revokedAt: null,
  createdAt: new Date().toISOString(),
};
const fetchMock = vi.fn();
beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

it('lists saved integrations without credentials and revokes with a same-origin JSON body', async () => {
  fetchMock
    .mockResolvedValueOnce(new Response(JSON.stringify({ secrets: [secret] })))
    .mockResolvedValueOnce(new Response(null, { status: 204 }))
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          secrets: [{ ...secret, revokedAt: new Date().toISOString() }],
        }),
      ),
    );
  render(<SavedIntegrations />);
  expect(await screen.findByText('Stripe')).toBeInTheDocument();
  expect(screen.getByText(/api\.stripe\.com/)).toHaveTextContent('GET, POST');
  expect(fetchMock.mock.calls[0]![0]).toBe('/api/account/integrations');
  fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  expect(fetchMock.mock.calls[1]![0]).toBe('/api/account/integrations');
  expect(fetchMock.mock.calls[1]![1]).toMatchObject({
    method: 'DELETE',
    credentials: 'same-origin',
    body: JSON.stringify({ secretRef: secret.secretRef }),
  });
  await waitFor(() =>
    expect(
      screen.getByText('No saved integrations.', { exact: false }),
    ).toBeInTheDocument(),
  );
});

it('explains when nothing is saved and reports load failures', async () => {
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify({ secrets: [] })),
  );
  render(<SavedIntegrations />);
  expect(
    await screen.findByText('No saved integrations.', { exact: false }),
  ).toBeInTheDocument();
  fetchMock.mockResolvedValueOnce(new Response('nope', { status: 500 }));
  render(<SavedIntegrations />);
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Saved integrations are unavailable.',
  );
});
