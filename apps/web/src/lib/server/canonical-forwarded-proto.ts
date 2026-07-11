/**
 * Behind a TLS-terminating tunnel or proxy (ngrok in local dev, some
 * self-host setups), the Next.js server sees a plain-http connection and
 * reports `x-forwarded-proto: http` even though the browser reached us over
 * https. Better Auth derives its base URL from that header, so OAuth
 * redirect URIs silently downgrade to http:// and token exchanges fail with
 * redirect-mismatch errors (e.g. Entra AADSTS500112).
 *
 * When a request is addressed to the canonical `R_APP_URL` host, the
 * configured URL is authoritative for the scheme — rewrite the header to
 * match. Requests to other hosts (localhost, preview domains) pass through
 * untouched.
 */
export function withCanonicalForwardedProto(
  request: Request,
  roomoteAppUrl: string,
): Request {
  let canonical: URL;

  try {
    canonical = new URL(roomoteAppUrl);
  } catch {
    return request;
  }

  // Chained proxies can append to x-forwarded-host; the first entry is the
  // host the client actually requested.
  const forwardedHost = request.headers
    .get('x-forwarded-host')
    ?.split(',')[0]
    ?.trim();
  const host = forwardedHost || request.headers.get('host');

  if (!host || host.toLowerCase() !== canonical.host.toLowerCase()) {
    return request;
  }

  const proto = canonical.protocol.replace(/:$/, '');

  if (request.headers.get('x-forwarded-proto') === proto) {
    return request;
  }

  const headers = new Headers(request.headers);
  headers.set('x-forwarded-proto', proto);

  // Rebuild from the URL rather than the Request copy-constructor: framework
  // subclasses (NextRequest) carry private state the constructor rejects.
  const init: RequestInit & { duplex?: 'half' } = {
    method: request.method,
    headers,
    redirect: request.redirect,
    signal: request.signal,
  };

  if (request.body && request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = request.body;
    // Node requires duplex when constructing a request with a stream body.
    init.duplex = 'half';
  }

  return new Request(request.url, init);
}
