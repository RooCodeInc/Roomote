import { request } from 'node:http';
import { startJevgrepProxy } from '../jevgrep-proxy';

let proxy: Awaited<ReturnType<typeof startJevgrepProxy>>;
const upstream = vi.fn();
const answers = { relevant: { type: 'noul', noul: 0.8 } };

function send(
  options: {
    path?: string;
    method?: string;
    body?: string;
    headers?: Record<string, string>;
  } = {},
) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const url = new URL(proxy.endpoint);
    if (options.path) url.pathname = options.path;
    const req = request(
      url,
      {
        method: options.method ?? 'POST',
        agent: false,
        headers: { 'content-type': 'application/json', ...options.headers },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode!, body }));
      },
    );
    req.on('error', reject);
    req.on('socket', (socket) => socket.on('error', reject));
    req.end(options.body ?? JSON.stringify({ state: 'source', questions: {} }));
  });
}

beforeEach(async () => {
  upstream
    .mockReset()
    .mockImplementation(async () => Response.json({ answers }));
  vi.stubGlobal('fetch', upstream);
  proxy = await startJevgrepProxy({
    endpoint: 'https://gateway.example/api/inference/jevgrep/v1/systemone',
    token: 'private-run-bearer',
    bypassHeader: 'x-test-bypass',
    bypassValue: 'private-bypass',
  });
});
afterEach(async () => {
  await proxy.close();
  vi.unstubAllGlobals();
});

it('authenticates only the fixed Jevgrep upstream and keeps credentials out of responses', async () => {
  const response = await send({
    headers: { authorization: 'attacker', 'x-test-bypass': 'attacker' },
  });
  expect(response).toEqual({ status: 200, body: JSON.stringify({ answers }) });
  expect(upstream).toHaveBeenCalledWith(
    'https://gateway.example/api/inference/jevgrep/v1/systemone',
    expect.objectContaining({
      method: 'POST',
      redirect: 'error',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer private-run-bearer',
        'x-test-bypass': 'private-bypass',
      },
    }),
  );
});

it.each<Parameters<typeof send>[0]>([
  { path: '/api/trpc' },
  { method: 'GET' },
  { headers: { origin: 'https://untrusted.example' } },
  { headers: { 'content-type': 'text/plain' } },
])(
  'rejects requests outside the local JSON evaluation capability: %j',
  async (options) => {
    expect((await send(options)).status).toBeGreaterThanOrEqual(400);
    expect(upstream).not.toHaveBeenCalled();
  },
);

it('rejects an oversized declared body before accepting source', async () => {
  expect(
    (
      await send({
        body: '',
        headers: { 'content-length': String(2 * 1024 * 1024 + 1) },
      })
    ).status,
  ).toBe(413);
  expect(upstream).not.toHaveBeenCalled();
});

it('sanitizes upstream errors', async () => {
  upstream.mockRejectedValue(new Error('private-run-bearer'));
  const response = await send();
  expect(response.status).toBe(502);
  expect(response.body).not.toContain('private');
});

it('closes the listener when the task ends', async () => {
  await proxy.close();
  await expect(send()).rejects.toThrow();
});
