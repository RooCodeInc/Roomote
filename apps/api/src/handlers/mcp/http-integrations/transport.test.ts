import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createHttpsServer } from 'node:https';
import { type AddressInfo } from 'node:net';
import { type Duplex } from 'node:stream';
import {
  assertEgressUrlAllowed,
  createGuardedConnectOptions,
} from '@roomote/sdk/server/safe-fetch';
import { integrationRequest, type HttpIntegrationsConfig } from './broker';

// Local TLS is admitted only by these test-boundary stubs, never production config.
vi.mock('@roomote/sdk/server/safe-fetch', () => ({
  assertEgressUrlAllowed: vi.fn(),
  createGuardedConnectOptions: vi.fn(),
}));

it('uses native HTTPS, injected credentials and guarded connect options without a sidecar', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'http-integrations-transport-'));
  const sockets = new Set<Duplex>();
  let requests = 0;
  let receivedCredential: string | undefined;
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      join(dir, 'key.pem'),
      '-out',
      join(dir, 'cert.pem'),
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=IP:127.0.0.1',
    ],
    { stdio: 'ignore' },
  );
  const ca = readFileSync(join(dir, 'cert.pem'), 'utf8');
  const upstream = createHttpsServer(
    { key: readFileSync(join(dir, 'key.pem')), cert: ca },
    (req, res) => {
      requests++;
      receivedCredential = req.headers.authorization;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    },
  );
  upstream.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  vi.stubEnv('HTTP_TLS_TEST_SECRET', 'raw-test-secret');
  vi.stubEnv('HTTPS_PROXY', 'http://127.0.0.1:1');
  vi.stubEnv('HTTP_PROXY', 'http://127.0.0.1:1');
  vi.stubEnv('ALL_PROXY', 'http://127.0.0.1:1');
  vi.mocked(createGuardedConnectOptions).mockReturnValue({ ca });
  try {
    await new Promise<void>((resolve) =>
      upstream.listen(0, '127.0.0.1', resolve),
    );
    const port = (upstream.address() as AddressInfo).port;
    const config: HttpIntegrationsConfig = {
      integrations: [
        {
          id: 'local',
          description: 'Local TLS transport test',
          origin: `https://127.0.0.1:${port}`,
          rules: [{ method: 'GET', pathPrefix: '/items' }],
          credential: {
            header: 'Authorization',
            valueEnv: 'HTTP_TLS_TEST_SECRET',
            prefix: 'Bearer ',
          },
        },
      ],
    };
    const args = { integrationId: 'local', method: 'GET', path: '/items' };
    await expect(
      integrationRequest(config, 'run:transport', args, 'actor'),
    ).resolves.toMatchObject({ status: 200, body: '{"ok":true}' });
    expect(assertEgressUrlAllowed).toHaveBeenCalledWith(
      new URL('/items', config.integrations[0]!.origin),
    );
    expect(createGuardedConnectOptions).toHaveBeenCalledWith({
      allowedPrivateCidrs: undefined,
    });
    expect(requests).toBe(1);
    expect(receivedCredential).toBe('Bearer raw-test-secret');
    vi.mocked(createGuardedConnectOptions).mockReturnValue({});
    await expect(
      integrationRequest(config, 'run:transport', args, 'actor'),
    ).rejects.toThrow('Integration request failed');
    expect(requests).toBe(1);
    vi.mocked(assertEgressUrlAllowed).mockImplementationOnce(() => {
      throw new Error('private address');
    });
    await expect(
      integrationRequest(config, 'run:transport', args, 'actor'),
    ).rejects.toThrow('Integration request failed');
    expect(requests).toBe(1);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  }
}, 15_000);
