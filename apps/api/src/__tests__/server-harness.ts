import type { ServerType } from '@hono/node-server';

import type { StartApiServerOptions } from '../server';

export type RunningApiServer = {
  baseUrl: string;
  close: () => Promise<void>;
};

function closeServer(server: ServerType): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

export async function startTestApiServer(
  options: StartApiServerOptions = {},
): Promise<RunningApiServer> {
  const { startApiServer } = await import('../server');
  const { server, address } = await startApiServer({
    port: 0,
    hostname: '127.0.0.1',
    installObservedFetch: false,
    logStartup: false,
    ...options,
  });

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => closeServer(server),
  };
}
