import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ServiceCredentials } from './ServiceCredentials';

const { toastSuccessMock, toastWarningMock } = vi.hoisted(() => ({
  toastSuccessMock: vi.fn(),
  toastWarningMock: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: { success: toastSuccessMock, warning: toastWarningMock },
}));

const sessionId = '6a1f8f1e-0000-4000-8000-000000000006';
const secretRef = '6a1f8f1e-0000-4000-8000-000000000007';
const pendingRef = '6a1f8f1e-0000-4000-8000-000000000008';
const credential = 'disposable-test-credential';
const policy = {
  label: 'Demo service',
  origin: 'https://api.example.com:8443',
  headerName: 'authorization',
  headerPrefix: 'Bearer ',
  allowedMethods: ['GET', 'HEAD'],
  visibility: 'deployment' as const,
  expiresAt: new Date(Date.now() + 3600000).toISOString(),
  createdAt: new Date().toISOString(),
};
const pending = { ...policy, pendingRef };
const metadata = { ...policy, secretRef, revokedAt: null };
const fetchMock = vi.fn();
beforeEach(() => {
  toastSuccessMock.mockReset();
  toastWarningMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  fetchMock.mockImplementation(
    async () =>
      new Response(JSON.stringify({ pending: [pending], secrets: [] })),
  );
  window.location.hash = '';
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
async function open() {
  window.location.hash = '#integrations';
  render(<ServiceCredentials sessionId={sessionId} />);
  await screen.findByLabelText('API key');
}
function fill() {
  fireEvent.change(screen.getByLabelText('API key'), {
    target: { value: credential },
  });
}
it('does not approve while requests are loading', async () => {
  let finish!: (response: Response) => void;
  fetchMock.mockReturnValueOnce(
    new Promise<Response>((resolve) => {
      finish = resolve;
    }),
  );
  window.location.hash = '#integrations';
  render(<ServiceCredentials sessionId={sessionId} />);
  expect(screen.queryByLabelText('API key')).not.toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: 'Save' }),
  ).not.toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(fetchMock.mock.calls[0]![1].method).toBeUndefined();
  finish(new Response(JSON.stringify({ pending: [pending], secrets: [] })));
  await screen.findByLabelText('API key');
  expect(fetchMock).toHaveBeenCalledOnce();
});
it('prefills a single-key consent flow, then dismisses with a toast while the server continues it', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  await open();
  expect(
    screen.getByRole('heading', {
      name: 'Add API key integration for Demo service',
    }),
  ).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  expect(
    screen.getByText(
      'The key is encrypted in our deployment database and never sent to the provider. Manage in Settings → Integrations.',
    ),
  ).toBeInTheDocument();
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  expect(
    screen.queryByText(
      /Review access details|I approve this service|All paths|Only you/,
    ),
  ).not.toBeInTheDocument();
  expect(screen.queryByText('authorization')).not.toBeInTheDocument();
  expect(screen.queryByText('"Bearer "')).not.toBeInTheDocument();
  expect(document.querySelectorAll('input[type="password"]')).toHaveLength(1);
  expect(
    screen.getByRole('radiogroup', {
      name: 'Who can use this integration?',
    }),
  ).toBeInTheDocument();
  expect(screen.getByRole('radio', { name: 'Only me' })).not.toBeChecked();
  expect(
    screen.getByRole('radio', { name: 'Everyone in this deployment' }),
  ).toBeChecked();
  expect(
    screen.queryByText(/Anyone in this deployment can make requests/),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByText(/For https:\/\/api\.example\.com:8443/),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByText(/Kept until|Expires .* hours after/),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole('heading', { name: /Add your .* API key/ }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Cancel' })).toHaveAttribute(
    'type',
    'button',
  );
  const password = screen.getByLabelText('API key');
  expect(password).toHaveAttribute('autocomplete', 'off');
  expect(password.closest('[role="dialog"]')).toHaveClass(
    'ph-no-capture',
    'ph-no-recording',
    'sentry-block',
  );
  fill();
  expect(fetchMock).toHaveBeenCalledOnce();
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify({ secret: metadata, resumed: true }), {
      status: 201,
    }),
  );
  const changed = vi.fn();
  window.addEventListener('roomote:integration-keys-changed', changed);
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() =>
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
  );
  expect(toastSuccessMock).toHaveBeenCalledOnce();
  expect(toastSuccessMock).toHaveBeenCalledWith('Integration saved.');
  expect(toastWarningMock).not.toHaveBeenCalled();
  expect(changed).toHaveBeenCalledOnce();
  window.removeEventListener('roomote:integration-keys-changed', changed);
  expect(fetchMock).toHaveBeenLastCalledWith(
    `/api/sessions/${sessionId}/secrets`,
    expect.objectContaining({
      method: 'POST',
      cache: 'no-store',
      credentials: 'same-origin',
      body: JSON.stringify({
        pendingRef,
        secret: credential,
        allowedMethods: policy.allowedMethods,
        visibility: 'deployment',
      }),
    }),
  );
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(
    fetchMock.mock.calls.every(
      ([url]) => url === `/api/sessions/${sessionId}/secrets`,
    ),
  ).toBe(true);
  expect(document.body.textContent).not.toContain(credential);
  expect(document.body.textContent).not.toContain(secretRef);
  expect(
    screen.queryByRole('button', { name: /Copy|Use in Session/ }),
  ).not.toBeInTheDocument();
  expect(log).not.toHaveBeenCalled();
  expect(error).not.toHaveBeenCalled();
});
it.each([
  { allowedMethods: ['GET'] },
  { allowedMethods: ['GET', 'POST'] },
  { allowedMethods: ['GET', 'POST', 'DELETE'] },
])(
  'submits the exact prepared method set %j only to the secure endpoint',
  async ({ allowedMethods }) => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          pending: [{ ...pending, allowedMethods }],
          secrets: [],
        }),
      ),
    );
    await open();
    expect(
      document.getElementById('service-credential-destination'),
    ).toBeNull();
    fill();
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          secret: { ...metadata, allowedMethods },
          resumed: true,
        }),
        { status: 201 },
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(toastSuccessMock).toHaveBeenCalledOnce());
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body)).toEqual({
      pendingRef,
      secret: credential,
      allowedMethods,
      visibility: 'deployment',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      fetchMock.mock.calls.every(
        ([url]) => url === `/api/sessions/${sessionId}/secrets`,
      ),
    ).toBe(true);
    expect(document.body.textContent).not.toContain(credential);
    expect(
      screen.queryByText('Manage approved secrets'),
    ).not.toBeInTheDocument();
  },
);
it('submits the owner visibility when Only me is selected', async () => {
  await open();
  fireEvent.click(screen.getByRole('radio', { name: 'Only me' }));
  fill();
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify({ secret: metadata, resumed: true }), {
      status: 201,
    }),
  );

  fireEvent.click(screen.getByRole('button', { name: 'Save' }));

  await waitFor(() => expect(toastSuccessMock).toHaveBeenCalledOnce());
  expect(JSON.parse(fetchMock.mock.calls[1]![1].body)).toEqual(
    expect.objectContaining({ visibility: 'owner' }),
  );
});
it.each([401, 403, 500])(
  'does not echo failed loading response %s',
  async (status) => {
    fetchMock.mockResolvedValueOnce(new Response(credential, { status }));
    window.location.hash = '#integrations';
    render(<ServiceCredentials sessionId={sessionId} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Sign in as this Session',
    );
    expect(document.body.textContent).not.toContain(credential);
  },
);
it.each([
  [
    'https://api.example.com:443',
    'https://api.example.com',
    'authorization',
    'Bearer ',
  ],
  [
    'https://api.example.com:8443',
    'https://api.example.com:8443',
    'authorization',
    'Basic ',
  ],
  [
    'https://api.example.com',
    'https://api.example.com',
    'authorization',
    'Token ',
  ],
  ['https://api.example.com', 'https://api.example.com', 'x-api-key', ''],
  ['https://api.example.com', 'https://api.example.com', 'api-key', ''],
  ['https://api.example.com', 'https://api.example.com', 'authorization', ''],
])(
  'shows destination %s as %s without disclosing %s prefix %s or approving',
  async (origin, canonicalOrigin, headerName, headerPrefix) => {
    const label = '<img src=x onerror=alert(1)>';
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          pending: [{ ...pending, origin, headerName, headerPrefix, label }],
          secrets: [],
        }),
      ),
    );
    await open();
    expect(
      screen.getByRole('heading', {
        name: `Add API key integration for ${label}`,
      }),
    ).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
    expect(screen.queryByText(`For ${canonicalOrigin} - GET, HEAD`)).toBeNull();
    expect(fetchMock).toHaveBeenCalledOnce();
    fill();
    expect(
      screen.queryByRole('button', { name: /info|How it is used|Review/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Review access details|GET and HEAD|with no prefix/),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(headerName)).not.toBeInTheDocument();
    if (headerPrefix)
      expect(
        screen.queryByText(JSON.stringify(headerPrefix)),
      ).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledOnce();
  },
);
it('clears the revealed key immediately and closes after save succeeds', async () => {
  fetchMock.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        pending: [
          pending,
          { ...pending, pendingRef: secretRef, label: 'Second' },
        ],
        secrets: [],
      }),
    ),
  );
  await open();
  fill();
  fireEvent.click(screen.getByRole('button', { name: 'Show value' }));
  let finish!: (response: Response) => void;
  fetchMock.mockReturnValueOnce(
    new Promise<Response>((resolve) => {
      finish = resolve;
    }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(screen.getByLabelText('API key')).toHaveValue('');
  expect(screen.getByLabelText('API key')).toHaveAttribute('type', 'password');
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  finish(
    new Response(JSON.stringify({ secret: metadata, resumed: true }), {
      status: 201,
    }),
  );
  await waitFor(() =>
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
  );
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(toastSuccessMock).toHaveBeenCalledWith('Integration saved.');
});
it('clears key and reveal state when selecting a different prepared request', async () => {
  fetchMock.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        pending: [
          pending,
          {
            ...pending,
            pendingRef: secretRef,
            label: 'Second',
            origin: 'https://second.example',
          },
        ],
        secrets: [],
      }),
    ),
  );
  await open();
  fill();
  fireEvent.click(screen.getByRole('button', { name: 'Show value' }));
  fireEvent.change(screen.getByLabelText('Prepared request'), {
    target: { value: secretRef },
  });
  expect(screen.getByLabelText('API key')).toHaveValue('');
  expect(screen.getByLabelText('API key')).toHaveAttribute('type', 'password');
  expect(
    screen.queryByText('For https://second.example - GET, HEAD'),
  ).not.toBeInTheDocument();
});
it('clears the key and asks for a new request when the prepared approval has expired', async () => {
  fetchMock.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        pending: [{ ...pending, expiresAt: '2020-01-01T00:00:00Z' }],
        secrets: [],
      }),
    ),
  );
  await open();
  fill();
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'This request has expired',
  );
  expect(screen.getByLabelText('API key')).toHaveValue('');
  expect(fetchMock).toHaveBeenCalledOnce();
});
it.each([400, 500])(
  'clears key on denied save (%s) and close without echoing response content',
  async (status) => {
    await open();
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Show value' }));
    fetchMock.mockResolvedValueOnce(new Response(credential, { status }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByRole('alert');
    expect(toastSuccessMock).not.toHaveBeenCalled();
    expect(toastWarningMock).not.toHaveBeenCalled();
    expect(screen.getByLabelText('API key')).toHaveValue('');
    expect(screen.getByLabelText('API key')).toHaveAttribute(
      'type',
      'password',
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).not.toContain(credential);
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    window.location.hash = '#integrations';
    fireEvent(window, new HashChangeEvent('hashchange'));
    expect(await screen.findByLabelText('API key')).toHaveValue('');
  },
);
it('does not expose approved-secret management metadata or controls', async () => {
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify({ pending: [pending], secrets: [metadata] })),
  );
  await open();
  expect(screen.queryByText('Manage approved secrets')).not.toBeInTheDocument();
  expect(
    screen.queryByRole('region', { name: 'Approved secrets' }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: 'Revoke' }),
  ).not.toBeInTheDocument();
  expect(screen.queryByText('authorization')).not.toBeInTheDocument();
  expect(screen.queryByText('"Bearer "')).not.toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledOnce();
});
it('closes with recovery feedback when the saved response reports no scheduled continuation', async () => {
  await open();
  fill();
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify({ secret: metadata, resumed: false }), {
      status: 201,
    }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() =>
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
  );
  expect(toastSuccessMock).not.toHaveBeenCalled();
  expect(toastWarningMock).toHaveBeenCalledWith(
    'Integration saved. The Session could not be notified. Ask the agent to check list_integration_keys and continue.',
  );
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(document.body.textContent).not.toContain(credential);
});
it('opens only from approval links and Cancel closes without submitting or adding history', async () => {
  render(<ServiceCredentials sessionId={sessionId} />);
  expect(
    screen.queryByRole('button', { name: 'Integration keys' }),
  ).not.toBeInTheDocument();
  window.location.hash = '#integrations';
  fireEvent(window, new HashChangeEvent('hashchange'));
  await screen.findByLabelText('API key');
  const historyLength = window.history.length;
  const replaceState = vi.spyOn(window.history, 'replaceState');
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(replaceState).toHaveBeenCalledOnce());
  const replacementUrl = replaceState.mock.calls[0]![2] as URL;
  expect(replacementUrl.hash).toBe('');
  expect(window.history.length).toBe(historyLength);
  expect(fetchMock).toHaveBeenCalledOnce();
  window.location.hash = '#integrations';
  fireEvent(window, new HashChangeEvent('hashchange'));
  await screen.findByLabelText('API key');
});
