import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { warmDevPreview } from '../../../../scripts/warm-dev-preview.mjs';

let server;
let port;

async function serve(handler) {
  server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
}

function login(response, location = '/') {
  response.writeHead(307, {
    Location: location,
    'Set-Cookie': [
      'better-auth.session_token=test%2Btoken.signature; Path=/; HttpOnly',
      'better-auth.session_data=; Max-Age=0',
    ],
  });
  response.end();
}

afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    server = undefined;
  }
});

describe('authenticated preview warmup', () => {
  it('retries login/server failures, retains the cookie, and waits for the full home body', async () => {
    let logins = 0;
    let homes = 0;
    let rendered = false;
    await serve((request, response) => {
      if (request.url === '/auth/dev-login') {
        if (++logins === 1) {
          response.writeHead(503).end();
        } else {
          login(response, `http://127.0.0.1:${port}/`);
        }
      } else {
        homes++;
        expect(request.headers.cookie).toBe(
          'better-auth.session_token=test%2Btoken.signature',
        );
        if (homes === 1) {
          response.writeHead(503).end();
        } else {
          response.writeHead(200).flushHeaders();
          setTimeout(() => {
            rendered = true;
            response.end('<html>Home</html>');
          }, 20);
        }
      }
    });
    const result = await warmDevPreview({ port, retryMs: 1 });
    expect(result.durationMs).toBeGreaterThan(0);
    expect(rendered).toBe(true);
    expect(logins).toBe(2);
    expect(homes).toBe(2);
  });

  it.each(['https://example.com/', '//example.com/', '/sign-in'])(
    'never follows or sends credentials to an unexpected login redirect: %s',
    async (location) => {
      const requests = [];
      await serve((request, response) => {
        requests.push(request.url);
        login(response, location);
      });
      await expect(warmDevPreview({ port })).rejects.toThrow(
        'local home redirect',
      );
      expect(requests).toEqual(['/auth/dev-login']);
    },
  );

  it('requires a nonempty session cookie, not just a redirect', async () => {
    await serve((_request, response) => {
      response
        .writeHead(307, {
          Location: '/',
          'Set-Cookie': 'better-auth.session_token=; Max-Age=0',
        })
        .end();
    });
    await expect(warmDevPreview({ port })).rejects.toThrow('session cookie');
  });

  it('does not retry a disabled dev login', async () => {
    let requests = 0;
    await serve((_request, response) => {
      requests++;
      response.writeHead(404).end();
    });
    await expect(warmDevPreview({ port })).rejects.toThrow('HTTP 404');
    expect(requests).toBe(1);
  });

  it('does not mistake an unauthenticated home redirect for success', async () => {
    await serve((request, response) => {
      if (request.url === '/auth/dev-login') login(response);
      else response.writeHead(307, { Location: '/sign-in' }).end();
    });
    await expect(warmDevPreview({ port })).rejects.toThrow('HTTP 307 on /');
  });

  it('bounds a hanging response body by the overall deadline', async () => {
    await serve((request, response) => {
      if (request.url === '/auth/dev-login') login(response);
      else response.writeHead(200).flushHeaders();
    });
    await expect(
      warmDevPreview({ port, timeoutMs: 100, retryMs: 1 }),
    ).rejects.toThrow('before home was ready');
  });

  it('cancels an in-flight request when the dev server stops', async () => {
    const shutdown = new AbortController();
    await serve(() => shutdown.abort());
    await expect(
      warmDevPreview({ port, signal: shutdown.signal }),
    ).rejects.toThrow('before home was ready');
  });

  it('retries timed-out requests within the overall budget', async () => {
    let requests = 0;
    await serve((request, response) => {
      if (++requests === 1) return;
      if (request.url === '/auth/dev-login') login(response);
      else response.end('Home');
    });
    await warmDevPreview({ port, requestTimeoutMs: 30, retryMs: 1 });
    expect(requests).toBe(3);
  });

  it.each([0, 65536, NaN])('rejects invalid ports: %s', async (invalid) => {
    await expect(warmDevPreview({ port: invalid })).rejects.toThrow(
      'Invalid preview port',
    );
  });
});
