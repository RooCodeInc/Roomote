import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { execa } from 'execa';

const workerDir = fileURLToPath(new URL('../..', import.meta.url));
const workerScript = path.join(workerDir, 'scripts/worker.ts');

const baseEnv = {
  HOME: process.env.HOME ?? '',
  PATH: process.env.PATH ?? '',
  PNPM_HOME: process.env.PNPM_HOME ?? '',
  NODE_ENV: 'development',
};

describe('worker CLI', () => {
  it('lists services without requiring the full app environment', async () => {
    const result = await execa('tsx', [workerScript, 'services'], {
      cwd: workerDir,
      preferLocal: true,
      extendEnv: false,
      env: baseEnv,
    });

    expect(result.stdout).toContain('Available services');
    expect(result.stdout).toContain('redis7');
    expect(result.stdout).toContain('postgres17');
  }, 120_000);

  // Regression test: Commander derives option keys from flag names, so
  // `--task-run-id` arrives as `options.taskRunId`. Reading `options.runId`
  // instead sent `id: undefined` to every SDK call and made all
  // snapshot_environment workers exit 1 at startup.
  it('passes the parsed --task-run-id through to the snapshot SDK calls', async () => {
    const requests: Array<{ url: string; body: string }> = [];

    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString()));
      req.on('end', () => {
        requests.push({ url: req.url ?? '', body });
        // Fail every call with a non-retryable tRPC error so the CLI
        // aborts after its first few requests instead of proceeding to
        // workspace setup.
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify([
            {
              error: {
                json: {
                  message: 'worker-cli test stub rejects all calls',
                  code: -32600,
                  data: { code: 'BAD_REQUEST', httpStatus: 400 },
                },
              },
            },
          ]),
        );
      });
    });

    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const { port } = server.address() as AddressInfo;

    try {
      const result = await execa(
        'tsx',
        [
          workerScript,
          'snapshot',
          '--task-run-id',
          '5',
          '--environment-id',
          'env-test',
          '--sandbox-id',
          'sandbox-test',
        ],
        {
          cwd: workerDir,
          preferLocal: true,
          extendEnv: false,
          reject: false,
          timeout: 90_000,
          env: {
            ...baseEnv,
            AUTH_TOKEN: 'worker-cli-test-token',
            TRPC_URL: `http://127.0.0.1:${port}`,
          },
        },
      );

      // The stub rejects every call, so the run must fail...
      expect(result.exitCode).toBe(1);

      // ...but the first taskRuns.update call must carry the parsed run id.
      const updateRequest = requests.find((request) =>
        request.url.includes('taskRuns.update'),
      );
      expect(
        updateRequest,
        `expected a taskRuns.update call, saw: ${requests
          .map((request) => request.url)
          .join(', ')}\nstderr: ${result.stderr}`,
      ).toBeDefined();
      expect(updateRequest?.body).toContain('"id":5');
    } finally {
      await closeServer(server);
    }
  }, 120_000);
});

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
