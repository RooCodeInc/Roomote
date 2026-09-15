import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { PersonalIntegrations } from './PersonalIntegrations';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const secret = {
  secretRef: '6a1f8f1e-0000-4000-8000-000000000011',
  label: 'Stripe',
  origin: 'https://api.stripe.com',
  headerName: 'authorization',
  headerPrefix: 'Bearer ',
  allowedMethods: ['GET', 'POST'],
  expiresAt: null,
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

it('lists integrations without credentials and revokes with a same-origin JSON body', async () => {
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
  render(<PersonalIntegrations />);
  expect(await screen.findByText('Stripe')).toBeInTheDocument();
  expect(screen.getByText(/api\.stripe\.com/)).toHaveTextContent(
    'GET, POST · kept until revoked',
  );
  expect(fetchMock.mock.calls[0]![0]).toBe('/api/account/integrations');
  fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  expect(fetchMock.mock.calls[1]![1]).toMatchObject({
    method: 'DELETE',
    credentials: 'same-origin',
    body: JSON.stringify({ secretRef: secret.secretRef }),
  });
  await waitFor(() =>
    expect(screen.getByText('No integrations yet.')).toBeInTheDocument(),
  );
});

it('adds an integration with the policy and key entered by the human', async () => {
  fetchMock
    .mockResolvedValueOnce(new Response(JSON.stringify({ secrets: [] })))
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ secret }), { status: 201 }),
    )
    .mockResolvedValueOnce(new Response(JSON.stringify({ secrets: [secret] })));
  render(<PersonalIntegrations />);
  expect(await screen.findByText('No integrations yet.')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Add integration' }));
  fireEvent.change(await screen.findByLabelText('Name'), {
    target: { value: 'Stripe' },
  });
  fireEvent.change(screen.getByLabelText('Service origin'), {
    target: { value: 'https://api.stripe.com' },
  });
  fireEvent.click(screen.getByLabelText('POST'));
  fireEvent.change(screen.getByLabelText('API key'), {
    target: { value: 'disposable-test-credential' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save integration' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  expect(fetchMock.mock.calls[1]![0]).toBe('/api/account/integrations');
  expect(fetchMock.mock.calls[1]![1]).toMatchObject({
    method: 'POST',
    credentials: 'same-origin',
  });
  expect(JSON.parse(fetchMock.mock.calls[1]![1].body)).toEqual({
    label: 'Stripe',
    origin: 'https://api.stripe.com',
    headerName: 'authorization',
    headerPrefix: 'Bearer ',
    allowedMethods: ['GET', 'HEAD', 'POST'],
    secret: 'disposable-test-credential',
  });
  expect(await screen.findByText('Stripe')).toBeInTheDocument();
});

it('reports load failures', async () => {
  fetchMock.mockResolvedValueOnce(new Response('nope', { status: 500 }));
  render(<PersonalIntegrations />);
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Integrations are unavailable.',
  );
});
