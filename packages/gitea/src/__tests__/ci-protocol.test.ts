import { once } from 'node:events';
import { createServer } from 'node:http';

import { describe, expect, it } from 'vitest';

import { getGiteaActionRun, getGiteaActionRunFailureEvidence } from '../ci';

describe('Actions response compatibility over HTTP', () => {
  it.each(
    ['nested', 'flat'].flatMap((shape) =>
      [undefined, '', ' \t '].map((headSha) => ({ shape, headSha })),
    ),
  )(
    'reads bare $shape job arrays with head_sha=$headSha without losing ordinary Gitea fields',
    async ({ shape, headSha }) => {
      const paths: string[] = [];
      const server = createServer((request, response) => {
        const path = new URL(request.url!, 'http://localhost').pathname;
        paths.push(path);
        if (request.headers.authorization !== 'Bearer fixture-token') {
          response.writeHead(401).end();
          return;
        }
        if (path.endsWith('/actions/runs/99')) {
          response.setHeader('content-type', 'application/json');
          response.end(
            JSON.stringify({
              id: 99,
              status: 'completed',
              conclusion: 'failure',
              commit_sha: 'forgejo-commit',
              ...(headSha === undefined ? {} : { head_sha: headSha }),
            }),
          );
        } else if (path.endsWith('/actions/runs/100')) {
          response.setHeader('content-type', 'application/json');
          response.end(
            JSON.stringify({
              id: 100,
              head_sha: 'gitea-commit',
              commit_sha: 'alternate-commit',
            }),
          );
        } else if (path.endsWith('/actions/runs/99/jobs') && shape === 'flat') {
          response.writeHead(404).end();
        } else if (path.endsWith('/jobs')) {
          response.setHeader('content-type', 'application/json');
          response.end(
            JSON.stringify([
              { id: 7, name: 'test', conclusion: 'failure', run_id: 99 },
              { id: 8, name: 'lint', conclusion: 'success', run_id: 99 },
              ...(shape === 'flat'
                ? [
                    {
                      id: 9,
                      name: 'other run',
                      conclusion: 'failure',
                      run_id: 98,
                    },
                  ]
                : []),
            ]),
          );
        } else if (path.endsWith('/actions/jobs/7/logs')) {
          response.end('AssertionError: fixture failure\n');
        } else {
          response.writeHead(404).end();
        }
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No port');
      const params = {
        repositoryFullName: 'acme/backend',
        token: 'fixture-token',
        baseUrl: `http://127.0.0.1:${address.port}`,
      };
      try {
        const run = await getGiteaActionRun({ ...params, runId: 99 });
        const ordinary = await getGiteaActionRun({ ...params, runId: 100 });
        const evidence = await getGiteaActionRunFailureEvidence({
          ...params,
          runId: 99,
        });
        expect.soft(run?.head_sha).toBe('forgejo-commit');
        expect(ordinary?.head_sha).toBe('gitea-commit');
        expect.soft(evidence).toContain('job="test"');
        expect(evidence).toContain('AssertionError: fixture failure');
        expect(evidence).not.toContain('other run');
        expect(paths.filter((path) => path.endsWith('/logs'))).toEqual([
          '/api/v1/repos/acme/backend/actions/jobs/7/logs',
        ]);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    },
  );
});
