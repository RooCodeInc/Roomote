import { EventEmitter } from 'node:events';
import { verifySessionProxyConnection } from '../session-proxy';
import type { WorkerEnv } from '../worker-env';

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  readFile: vi.fn(() => 'public CA fixture'),
}));
vi.mock('node:https', () => ({ request: mocks.request }));
vi.mock('node:fs', () => ({ readFileSync: mocks.readFile }));

const worker = {
  sessionEgressAdmissionMode: 'authenticated_proxy',
  sessionEgressServices: [{ origin: 'https://service.example.com' }],
  buildSessionEgressClientEnv: () => ({
    ROOMOTE_SESSION_PROXY_URL:
      'https://workload:rproxy_fixture@proxy.example.com:8444/',
    ROOMOTE_SESSION_PROXY_CA_FILE: '/public.pem',
  }),
} as unknown as WorkerEnv;

beforeEach(() => vi.clearAllMocks());

it('verifies TLS CONNECT using only the proxy capability, without an upstream HTTP request', async () => {
  const socket = { destroy: vi.fn() };
  const req = Object.assign(new EventEmitter(), {
    end: vi.fn(() =>
      queueMicrotask(() =>
        req.emit('connect', { statusCode: 200 }, socket, Buffer.alloc(0)),
      ),
    ),
  });
  mocks.request.mockReturnValue(req);
  await verifySessionProxyConnection(worker);
  expect(mocks.request).toHaveBeenCalledWith(
    expect.objectContaining({
      hostname: 'proxy.example.com',
      port: '8444',
      method: 'CONNECT',
      path: 'service.example.com:443',
      ca: 'public CA fixture',
      rejectUnauthorized: true,
    }),
  );
  const options = mocks.request.mock.calls[0]![0];
  expect(Object.keys(options.headers)).toEqual(['Proxy-Authorization']);
  expect(req.end).toHaveBeenCalledWith();
  expect(socket.destroy).toHaveBeenCalledOnce();
});

it.each([407, 403, 502])(
  'fails closed on proxy status %i',
  async (statusCode) => {
    const req = Object.assign(new EventEmitter(), {
      end: () =>
        queueMicrotask(() =>
          req.emit(
            'connect',
            { statusCode },
            { destroy: vi.fn() },
            Buffer.alloc(0),
          ),
        ),
    });
    mocks.request.mockReturnValue(req);
    await expect(verifySessionProxyConnection(worker)).rejects.toThrow(
      'no credential fallback',
    );
  },
);

it('does not expose transport diagnostics containing credentials', async () => {
  const req = Object.assign(new EventEmitter(), {
    end: () =>
      queueMicrotask(() => req.emit('error', new Error('rproxy_fixture'))),
  });
  mocks.request.mockReturnValue(req);
  await expect(verifySessionProxyConnection(worker)).rejects.toThrow(
    'TLS trust',
  );
});
