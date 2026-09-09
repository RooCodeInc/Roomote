import { fireEvent, render, screen } from '@testing-library/react';
import { SessionSecrets } from './SessionSecrets';

const sessionId = '6a1f8f1e-0000-4000-8000-000000000006';
const secretRef = '6a1f8f1e-0000-4000-8000-000000000007';
const pendingRef = '6a1f8f1e-0000-4000-8000-000000000008';
const credential = 'disposable-test-credential';
const policy = {
  label: 'Demo service',
  origin: 'https://api.example.com:8443',
  headerName: 'authorization',
  headerPrefix: 'Bearer ',
  expiresAt: new Date(Date.now() + 3600000).toISOString(),
  createdAt: new Date().toISOString(),
};
const pending = { ...policy, pendingRef };
const metadata = { ...policy, secretRef, revokedAt: null };
const fetchMock = vi.fn();
beforeEach(() => {
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
  render(<SessionSecrets sessionId={sessionId} />);
  fireEvent.click(screen.getByRole('button', { name: 'Session secrets' }));
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
  render(<SessionSecrets sessionId={sessionId} />);
  fireEvent.click(screen.getByRole('button', { name: 'Session secrets' }));
  expect(screen.queryByLabelText('API key')).not.toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: 'Allow for this Session' }),
  ).not.toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(fetchMock.mock.calls[0]![1].method).toBeUndefined();
  finish(new Response(JSON.stringify({ pending: [pending], secrets: [] })));
  await screen.findByLabelText('API key');
  expect(fetchMock).toHaveBeenCalledOnce();
});
it('prefills a single-key consent flow and reports server-scheduled continuation without another client request', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  await open();
  expect(
    screen.getByRole('heading', { name: 'Add your Demo service API key' }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole('button', { name: 'Allow for this Session' }),
  ).toBeEnabled();
  expect(
    screen.getByRole('button', { name: 'Allow for this Session' }),
  ).toHaveAccessibleDescription('For https://api.example.com:8443');
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  expect(
    screen.queryByText(
      /Review access details|I approve this service|All paths|Only you/,
    ),
  ).not.toBeInTheDocument();
  expect(screen.queryByText('authorization')).not.toBeInTheDocument();
  expect(screen.queryByText('"Bearer "')).not.toBeInTheDocument();
  expect(document.querySelectorAll('input[type="password"]')).toHaveLength(1);
  expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
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
  fireEvent.click(
    screen.getByRole('button', { name: 'Allow for this Session' }),
  );
  expect(await screen.findByRole('status')).toHaveTextContent(
    'API key saved. The Session has been notified without sharing your key.',
  );
  expect(fetchMock).toHaveBeenLastCalledWith(
    `/api/sessions/${sessionId}/secrets`,
    expect.objectContaining({
      method: 'POST',
      cache: 'no-store',
      credentials: 'same-origin',
      body: JSON.stringify({ pendingRef, secret: credential }),
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
it.each([401, 403, 500])(
  'does not echo failed loading response %s',
  async (status) => {
    fetchMock.mockResolvedValueOnce(new Response(credential, { status }));
    render(<SessionSecrets sessionId={sessionId} />);
    fireEvent.click(screen.getByRole('button', { name: 'Session secrets' }));
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
      screen.getByRole('heading', { name: `Add your ${label} API key` }),
    ).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByText(`For ${canonicalOrigin}`)).toBeInTheDocument();
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
it('clears the revealed key immediately on save and leaves the next request masked', async () => {
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
  fireEvent.click(
    screen.getByRole('button', { name: 'Allow for this Session' }),
  );
  expect(screen.getByLabelText('API key')).toHaveValue('');
  expect(screen.getByLabelText('API key')).toHaveAttribute('type', 'password');
  expect(
    screen.getByRole('button', { name: 'Allow for this Session' }),
  ).toBeDisabled();
  finish(
    new Response(JSON.stringify({ secret: metadata, resumed: true }), {
      status: 201,
    }),
  );
  await screen.findByRole('status');
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(
    screen.getByRole('heading', { name: 'Add your Second API key' }),
  ).toBeInTheDocument();
  expect(screen.getByLabelText('API key')).toHaveValue('');
  expect(screen.getByLabelText('API key')).toHaveAttribute('type', 'password');
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
  expect(screen.getByText('For https://second.example')).toBeInTheDocument();
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
  fireEvent.click(
    screen.getByRole('button', { name: 'Allow for this Session' }),
  );
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'This request has expired',
  );
  expect(screen.getByLabelText('API key')).toHaveValue('');
  expect(fetchMock).toHaveBeenCalledOnce();
});
it('clears key on failed save and close without echoing response content', async () => {
  await open();
  fill();
  fireEvent.click(screen.getByRole('button', { name: 'Show value' }));
  fetchMock.mockResolvedValueOnce(new Response(credential, { status: 400 }));
  fireEvent.click(
    screen.getByRole('button', { name: 'Allow for this Session' }),
  );
  await screen.findByRole('alert');
  expect(screen.getByLabelText('API key')).toHaveValue('');
  expect(screen.getByLabelText('API key')).toHaveAttribute('type', 'password');
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(document.body.textContent).not.toContain(credential);
  fill();
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  fireEvent.click(screen.getByRole('button', { name: 'Session secrets' }));
  expect(await screen.findByLabelText('API key')).toHaveValue('');
});
it('revokes without exposing references and clears any entered key', async () => {
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify({ pending: [pending], secrets: [metadata] })),
  );
  await open();
  expect(
    screen.queryByRole('region', { name: 'Approved secrets' }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: 'Revoke' }),
  ).not.toBeInTheDocument();
  fill();
  fireEvent.click(screen.getByRole('button', { name: 'Show value' }));
  fireEvent.click(
    screen.getByRole('button', { name: 'Manage approved secrets' }),
  );
  expect(screen.queryByLabelText('API key')).not.toBeInTheDocument();
  expect(screen.getByText('authorization')).toBeInTheDocument();
  expect(screen.getByText('"Bearer "')).toBeInTheDocument();
  fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
  fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
  await screen.findByText('Demo service (revoked)');
  expect(screen.getByRole('button', { name: 'Revoke' })).toBeDisabled();
  expect(JSON.parse(fetchMock.mock.calls.at(-1)![1].body)).toEqual({
    secretRef,
  });
  fireEvent.click(
    screen.getByRole('button', { name: 'Back to pending requests' }),
  );
  expect(screen.getByLabelText('API key')).toHaveValue('');
  expect(screen.getByLabelText('API key')).toHaveAttribute('type', 'password');
});
it('keeps saved status with native-tool fallback when server continuation was not scheduled', async () => {
  await open();
  fill();
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify({ secret: metadata, resumed: false }), {
      status: 201,
    }),
  );
  fireEvent.click(
    screen.getByRole('button', { name: 'Allow for this Session' }),
  );
  expect(await screen.findByRole('status')).toHaveTextContent(
    'API key saved. The Session could not be notified. Ask the agent to check list_session_secrets and continue.',
  );
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(screen.queryByLabelText('API key')).not.toBeInTheDocument();
  fireEvent.click(
    screen.getByRole('button', { name: 'Manage approved secrets' }),
  );
  expect(screen.getByText('Demo service (ready)')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Revoke' })).toBeEnabled();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(document.body.textContent).not.toContain(credential);
});
it('opens from initial deep links and hash changes while retaining the header button', async () => {
  window.location.hash = '#session-secrets';
  render(<SessionSecrets sessionId={sessionId} />);
  await screen.findByLabelText('API key');
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  fireEvent(window, new HashChangeEvent('hashchange'));
  await screen.findByLabelText('API key');
  expect(
    screen.getByRole('button', { name: 'Session secrets', hidden: true }),
  ).toBeInTheDocument();
});
