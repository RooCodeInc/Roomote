import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import superjson from 'superjson';

import { handleCloneRepository } from '../clone-repository';

const config = {
  token: 'run-token',
  platformApiUrl: 'https://api.example.test',
};

function readToolJson(result: { content: { type: string; text?: string }[] }) {
  return JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;
}

describe('handleCloneRepository', () => {
  let server: Server;
  let sandboxServerUrl: string;
  let lastRequest: { authorization?: string; body: string } | undefined;
  let respond: (req: { input: unknown }) => {
    status: number;
    body: unknown;
  };
  let hang = false;

  beforeEach(async () => {
    lastRequest = undefined;
    hang = false;
    respond = () => ({ status: 200, body: {} });
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        lastRequest = { authorization: req.headers.authorization, body };
        const batch = JSON.parse(body) as Record<string, { json: unknown }>;
        const input = superjson.deserialize(batch['0'] as never) as unknown;
        if (hang) {
          return;
        }
        const response = respond({ input });
        res.writeHead(response.status, {
          'content-type': 'application/json',
        });
        res.end(JSON.stringify([response.body]));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    sandboxServerUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('calls the local sandbox server with the run token and reports the checkout path', async () => {
    respond = ({ input }) => ({
      status: 200,
      body: {
        result: {
          data: superjson.serialize({
            success: true,
            repositoryFullName: (input as { repositoryFullName: string })
              .repositoryFullName,
            repositoryPath: '/sandbox/repos/acme/api',
            alreadyCheckedOut: false,
            manifestPath: '/sandbox/repos/REPOSITORIES.md',
          }),
        },
      },
    });

    const result = await handleCloneRepository(
      { repositoryFullName: ' acme/api ', branch: 'release' },
      config,
      { sandboxServerUrl },
    );

    expect(lastRequest?.authorization).toBe('Bearer run-token');
    expect(lastRequest?.body).toContain('"repositoryFullName":"acme/api"');
    expect(lastRequest?.body).toContain('"branch":"release"');
    expect(readToolJson(result)).toMatchObject({
      success: true,
      repositoryPath: '/sandbox/repos/acme/api',
      alreadyCheckedOut: false,
      message: expect.stringContaining(
        'checked out at /sandbox/repos/acme/api',
      ),
    });
  });

  it('surfaces sandbox server errors as tool errors', async () => {
    respond = () => ({
      status: 404,
      body: {
        error: {
          json: {
            message:
              "Repository 'acme/missing' is not an active repository of this deployment.",
            code: -32004,
            data: { code: 'NOT_FOUND', httpStatus: 404 },
          },
        },
      },
    });

    const result = await handleCloneRepository(
      { repositoryFullName: 'acme/missing' },
      config,
      { sandboxServerUrl },
    );

    expect(readToolJson(result)).toEqual({
      success: false,
      error:
        "Failed to check out acme/missing: Repository 'acme/missing' is not an active repository of this deployment.",
    });
  });

  it('rejects an empty repository name without calling the sandbox server', async () => {
    const result = await handleCloneRepository(
      { repositoryFullName: '  ' },
      config,
      { sandboxServerUrl },
    );

    expect(lastRequest).toBeUndefined();
    expect(readToolJson(result)).toEqual({
      success: false,
      error: 'repositoryFullName is required (owner/repo)',
    });
  });

  it('reports a timeout instead of hanging on a stalled clone', async () => {
    // Never answer; let the tool deadline fire.
    hang = true;

    const result = await handleCloneRepository(
      { repositoryFullName: 'acme/api' },
      config,
      { sandboxServerUrl, timeoutMs: 50 },
    );

    expect(readToolJson(result).error).toContain(
      'Checking out acme/api did not finish within',
    );
  });
});
