import { readFileSync } from 'node:fs';
import { request } from 'node:https';
import type { WorkerEnv } from './worker-env';

/** Verify transport/auth from the worker, without sending a service HTTP request. */
export async function verifySessionProxyConnection(
  workerEnv: WorkerEnv,
): Promise<void> {
  if (workerEnv.sessionEgressAdmissionMode !== 'authenticated_proxy') return;
  const settings = workerEnv.buildSessionEgressClientEnv();
  const proxy = new URL(settings.ROOMOTE_SESSION_PROXY_URL!);
  const service = workerEnv.sessionEgressServices[0];
  if (!service) throw new Error('Session proxy has no usable service mapping');
  const destination = new URL(service.origin);
  const ca = readFileSync(settings.ROOMOTE_SESSION_PROXY_CA_FILE!, 'utf8');
  await new Promise<void>((resolve, reject) => {
    const req = request({
      protocol: 'https:',
      hostname: proxy.hostname,
      port: proxy.port || 443,
      method: 'CONNECT',
      path: `${destination.hostname}:${destination.port || 443}`,
      ca,
      rejectUnauthorized: true,
      signal: AbortSignal.timeout(10_000),
      headers: {
        'Proxy-Authorization': `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}`,
      },
    });
    req.on('connect', (response, socket, head) => {
      socket.destroy();
      if (response.statusCode !== 200 || head.length !== 0) {
        reject(
          new Error(
            `Session proxy CONNECT was denied (${response.statusCode ?? 0}); no credential fallback is permitted`,
          ),
        );
      } else resolve();
    });
    req.on('error', () =>
      reject(
        new Error(
          'Session proxy endpoint could not be reached or its TLS trust could not be verified; no credential fallback is permitted',
        ),
      ),
    );
    req.on('response', (response) => {
      response.resume();
      reject(
        new Error(
          `Session proxy did not establish a CONNECT tunnel (${response.statusCode ?? 0})`,
        ),
      );
    });
    req.end();
  });
}
