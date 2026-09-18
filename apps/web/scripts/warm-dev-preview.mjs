import { setTimeout as delay } from 'node:timers/promises';

/** Warm only the sandbox's opt-in dev login and authenticated home page. */
export async function warmDevPreview({
  port = 3000,
  signal,
  timeoutMs = 600_000,
  requestTimeoutMs = 180_000,
  retryMs = 1_000,
} = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('Invalid preview port');
  }

  const origin = `http://127.0.0.1:${port}`;
  const startedAt = Date.now();
  const deadline = AbortSignal.timeout(timeoutMs);
  const shutdown = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let cookie;
  let lastResult = 'not yet connected';

  while (!shutdown.aborted) {
    let terminal = false;
    try {
      const response = await fetch(
        `${origin}${cookie ? '/' : '/auth/dev-login'}`,
        {
          redirect: 'manual',
          signal: AbortSignal.any([
            shutdown,
            AbortSignal.timeout(requestTimeoutMs),
          ]),
          headers: cookie ? { Cookie: cookie } : {},
        },
      );
      lastResult = `HTTP ${response.status} on ${cookie ? '/' : '/auth/dev-login'}`;

      if (!cookie && response.status === 307) {
        const location = response.headers.get('location');
        const sessionCookie = response.headers
          .getSetCookie()
          .map((value) => value.split(';', 1)[0])
          .find((value) => /^better-auth\.session_token=.+$/.test(value));
        terminal = true;
        await response.body?.cancel();
        if ((location !== '/' && location !== `${origin}/`) || !sessionCookie) {
          throw new Error(
            'Dev login did not return a local home redirect and session cookie',
          );
        }
        cookie = sessionCookie;
        continue;
      }

      if (cookie && response.status === 200) {
        // A streamed Next response can send headers long before rendering ends.
        for await (const _chunk of response.body ?? []) {
          shutdown.throwIfAborted();
        }
        return { durationMs: Date.now() - startedAt };
      }

      await response.body?.cancel();
      if (response.status >= 300 && response.status < 500) {
        terminal = true;
        throw new Error(`Authenticated preview unavailable: ${lastResult}`);
      }
    } catch (error) {
      // Configuration/auth failures should not repeatedly create login sessions.
      if (terminal) {
        throw error;
      }
      lastResult = 'connection, response body or request timeout failure';
    }

    try {
      await delay(retryMs, undefined, { signal: shutdown });
    } catch {
      break;
    }
  }

  throw new Error(
    `Preview warmup stopped before home was ready (${lastResult})`,
  );
}
