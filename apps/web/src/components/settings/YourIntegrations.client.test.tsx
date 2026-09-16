import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { PersonalIntegrations, YourIntegrations } from './YourIntegrations';

const { toastSuccessMock, toastErrorMock } = vi.hoisted(() => ({
  toastSuccessMock: vi.fn(),
  toastErrorMock: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: { success: toastSuccessMock, error: toastErrorMock },
}));

const secret = {
  secretRef: '6a1f8f1e-0000-4000-8000-000000000011',
  label: 'Stripe',
  origin: 'https://api.stripe.com',
  headerName: 'authorization',
  headerPrefix: 'Bearer ',
  allowedMethods: ['GET', 'POST'],
  visibility: 'deployment',
  ownerName: null,
  canManage: true,
  expiresAt: null,
  revokedAt: null,
  createdAt: new Date().toISOString(),
};
const fetchMock = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

it('lists integrations without credentials and removes with a same-origin JSON body', async () => {
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
  render(<YourIntegrations />);
  expect(await screen.findByText('Stripe')).toBeInTheDocument();
  expect(screen.getByText(/api\.stripe\.com/)).toHaveTextContent(
    'GET, POST · kept until revoked',
  );
  expect(fetchMock.mock.calls[0]![0]).toBe(
    '/api/account/integrations?view=shared',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Remove Stripe' }));
  expect(
    screen.getByRole('heading', { name: 'Remove Stripe?' }),
  ).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  expect(fetchMock.mock.calls[1]![1]).toMatchObject({
    method: 'DELETE',
    credentials: 'same-origin',
    body: JSON.stringify({ secretRef: secret.secretRef }),
  });
  await waitFor(() =>
    expect(screen.getByText('No integrations yet.')).toBeInTheDocument(),
  );
  expect(toastSuccessMock).toHaveBeenCalledWith('Stripe removed.');
});

it('adds a shared integration without offering personal scope', async () => {
  fetchMock
    .mockResolvedValueOnce(new Response(JSON.stringify({ secrets: [] })))
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ secret }), { status: 201 }),
    )
    .mockResolvedValueOnce(new Response(JSON.stringify({ secrets: [secret] })));
  render(<YourIntegrations />);
  expect(await screen.findByText('No integrations yet.')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Add integration' }));
  expect(
    screen.queryByLabelText('Who can use this integration?'),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole('option', { name: 'Only me' }),
  ).not.toBeInTheDocument();
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
    visibility: 'deployment',
    secret: 'disposable-test-credential',
  });
  expect(await screen.findByText('Stripe')).toBeInTheDocument();
});

it('keeps private integrations out of the shared list', async () => {
  fetchMock.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        secrets: [
          secret,
          {
            ...secret,
            secretRef: '6a1f8f1e-0000-4000-8000-000000000012',
            label: 'Private API',
            visibility: 'owner',
          },
          {
            ...secret,
            secretRef: '6a1f8f1e-0000-4000-8000-000000000013',
            label: 'Someone else private API',
            visibility: 'owner',
            ownerName: 'Taylor',
          },
        ],
      }),
    ),
  );

  render(<YourIntegrations />);

  expect(await screen.findByText('Stripe')).toBeInTheDocument();
  expect(screen.queryByText('Private API')).not.toBeInTheDocument();
  expect(
    screen.queryByText('Someone else private API'),
  ).not.toBeInTheDocument();
});

it('shows only owned private integrations and always submits personal scope', async () => {
  const personalSecret = {
    ...secret,
    label: 'Personal API',
    visibility: 'owner',
  };
  fetchMock
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          secrets: [
            personalSecret,
            { ...secret, label: 'Shared API' },
            {
              ...personalSecret,
              secretRef: '6a1f8f1e-0000-4000-8000-000000000014',
              label: 'Other private API',
              ownerName: 'Taylor',
            },
          ],
        }),
      ),
    )
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ secret: personalSecret }), { status: 201 }),
    )
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ secrets: [personalSecret] })),
    );

  render(<PersonalIntegrations />);

  expect(await screen.findByText('Personal API')).toBeInTheDocument();
  expect(screen.queryByRole('columnheader')).not.toBeInTheDocument();
  expect(screen.queryByText('Shared API')).not.toBeInTheDocument();
  expect(screen.queryByText('Other private API')).not.toBeInTheDocument();
  expect(screen.queryByText(/Owned by/)).not.toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: 'Configure Personal API' }),
  ).not.toBeInTheDocument();
  const personalRow = screen.getByText('Personal API').closest('[role="row"]');
  expect(personalRow).not.toBeNull();
  expect(personalRow?.querySelectorAll('[role="cell"]')).toHaveLength(3);
  expect(screen.getByText(/api\.stripe\.com/).closest('[role="cell"]')).toBe(
    screen.getByText('Personal API').closest('[role="cell"]'),
  );
  fireEvent.click(
    screen.getByRole('button', { name: 'Add personal integration' }),
  );
  expect(
    screen.queryByLabelText('Who can use this integration?'),
  ).not.toBeInTheDocument();
  fireEvent.change(await screen.findByLabelText('Name'), {
    target: { value: 'Personal API' },
  });
  fireEvent.change(screen.getByLabelText('Service origin'), {
    target: { value: 'https://api.example.com' },
  });
  fireEvent.change(screen.getByLabelText('API key'), {
    target: { value: 'personal-test-credential' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save integration' }));

  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  expect(JSON.parse(fetchMock.mock.calls[1]![1].body)).toMatchObject({
    visibility: 'owner',
  });
});

it('shows who shared an integration and lets an authorized viewer change visibility', async () => {
  fetchMock
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          secrets: [
            secret,
            {
              ...secret,
              secretRef: '6a1f8f1e-0000-4000-8000-000000000012',
              label: 'Shared search',
              ownerName: 'Taylor',
              canManage: false,
            },
          ],
        }),
      ),
    )
    .mockResolvedValueOnce(new Response(JSON.stringify({ secret })))
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({ secrets: [{ ...secret, visibility: 'owner' }] }),
      ),
    );
  render(<YourIntegrations />);
  expect(await screen.findByText('Owned by Taylor')).toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: 'Configure Shared search' }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Configure Stripe' }));
  fireEvent.change(screen.getByLabelText('Who can use this integration?'), {
    target: { value: 'owner' },
  });
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  expect(fetchMock.mock.calls[1]![1]).toMatchObject({
    method: 'PATCH',
    body: JSON.stringify({
      secretRef: secret.secretRef,
      visibility: 'owner',
    }),
  });
});

it('reports load failures', async () => {
  fetchMock.mockResolvedValueOnce(new Response('nope', { status: 500 }));
  render(<YourIntegrations />);
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Integrations are unavailable.',
  );
});
