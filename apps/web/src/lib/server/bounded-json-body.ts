/**
 * Read a small JSON request body with a byte cap and a wall-clock budget, so a
 * slow or oversized client cannot hold a route open. Returns a status code on
 * failure instead of throwing; the caller decides how to answer.
 */
export async function readBoundedJsonBody(
  request: Request,
  options: { maxBytes: number; timeoutMs: number },
): Promise<
  { ok: true; value: unknown } | { ok: false; status: 400 | 408 | 413 }
> {
  const reader = request.body?.getReader();
  if (!reader) return { ok: false, status: 400 };
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let body = '';
  let bytes = 0;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new Error('Request unavailable'));
      void reader.cancel().catch(() => {});
    }, options.timeoutMs);
  });
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > options.maxBytes) {
        void reader.cancel().catch(() => {});
        return { ok: false, status: 413 };
      }
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
  } catch {
    return { ok: false, status: timedOut ? 408 : 400 };
  } finally {
    clearTimeout(timer!);
    reader.releaseLock();
  }
  try {
    return { ok: true, value: JSON.parse(body) as unknown };
  } catch {
    return { ok: false, status: 400 };
  }
}
