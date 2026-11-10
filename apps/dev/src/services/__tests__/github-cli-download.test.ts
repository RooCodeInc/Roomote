import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type RequestListener } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { execa } from 'execa';

const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));

describe.each(['.docker/app/Dockerfile', 'apps/worker/Dockerfile'])(
  '%s GitHub CLI download',
  (dockerfile) => {
    async function download(handler: RequestListener) {
      const directory = await mkdtemp(join(tmpdir(), 'roomote-gh-download-'));
      const output = join(directory, 'archive');
      const server = createServer(handler);
      try {
        await new Promise<void>((resolve) =>
          server.listen(0, '127.0.0.1', resolve),
        );
        const address = server.address();
        if (!address || typeof address === 'string')
          throw new Error('Missing test port');
        const source = await readFile(join(repoRoot, dockerfile), 'utf8');
        const line = source
          .split('\n')
          .find(
            (line) => line.includes('curl ') && /gh\.(deb|tar\.gz)/.test(line),
          );
        if (!line) throw new Error('Missing GitHub CLI download command');
        // Exercise the shipped curl flags; replace only the asset URL and output.
        const command = line
          .slice(line.indexOf('curl '))
          .replace(/\s*(?:&&)?\s*\\?\s*$/, '')
          .replace(
            /"(?:\$GH_CLI_URL|https:[^"]+)"/,
            `"http://127.0.0.1:${address.port}/asset"`,
          )
          .replace(/-o\s+\S+/, `-o "${output}"`);
        await writeFile(output, 'previous incomplete artifact');
        const result = await execa('sh', ['-c', command], {
          reject: false,
          timeout: 12000,
        });
        return {
          exitCode: result.exitCode,
          content: await readFile(output, 'utf8'),
        };
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        await rm(directory, { recursive: true, force: true });
      }
    }

    it('retries transient gateway failures and follows the artifact redirect', async () => {
      let attempts = 0;
      let artifacts = 0;
      const result = await download((request, response) => {
        if (request.url === '/artifact') {
          artifacts++;
          response.end('complete synthetic archive');
        } else if (++attempts <= 2) {
          response.writeHead(504).end('temporary upstream failure');
        } else {
          response.writeHead(302, { Location: '/artifact' }).end();
        }
      });
      expect(result).toEqual({
        exitCode: 0,
        content: 'complete synthetic archive',
      });
      expect(attempts).toBe(3);
      expect(artifacts).toBe(1);
    }, 15000);

    it('fails a permanent missing artifact without retrying', async () => {
      let attempts = 0;
      const result = await download((_request, response) => {
        attempts++;
        response.writeHead(404).end('not found');
      });
      expect(result.exitCode).toBe(22);
      expect(attempts).toBe(1);
    });

    it('fails after exhausting the transient-error retry budget', async () => {
      let attempts = 0;
      const result = await download((_request, response) => {
        attempts++;
        response.writeHead(504).end('still unavailable');
      });
      expect(result.exitCode).toBe(22);
      expect(attempts).toBe(4);
    }, 15000);
  },
);
