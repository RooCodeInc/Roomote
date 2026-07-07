import type { IncomingMessage, ServerResponse } from 'http';
import type httpProxy from 'http-proxy';
import { validateToken, validateState } from '../services/auth';
import { buildSetCookieHeader, getCookieDomain } from '../lib/cookies';
import { tryNestedFallback } from '../lib/nested-routing';
import { proxyRequest } from '../lib/proxy';
import { logger, escapeForLog } from '../lib/logger';
import { isLoopbackHostname } from '@roomote/types';
import { config } from '../config';
import type { AccessLogContext } from '../lib/access-log';

/**
 * Determine if the Secure flag should be set on the cookie.
 * With SameSite=None, browsers silently reject cookies without Secure on
 * non-localhost HTTPS origins. Set Secure based on request protocol, not
 * just NODE_ENV, so staging/preview deploys work correctly.
 */
function shouldSetSecure(req: IncomingMessage): boolean {
  const forwardedProto = req.headers['x-forwarded-proto'];
  if (typeof forwardedProto === 'string' && forwardedProto.length > 0) {
    const protocol = forwardedProto.split(',')[0]!.trim();
    return protocol === 'https';
  }

  // In production, always secure. In dev, check if host is localhost.
  if (config.NODE_ENV === 'production') {
    return true;
  }

  const host = req.headers.host || '';
  const hostname = host.split(':')[0] || '';
  return !isLoopbackHostname(hostname);
}

/**
 * Handle the /auth/callback route.
 * Called after the user authenticates with the main app.
 *
 * Validates state from Redis and sets the preview_auth cookie.
 * In nested mode, a state miss may belong to an inner preview-proxy; in that
 * case we selectively forward to the nested wildcard preview route.
 */
export async function handleAuthCallback(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  proxy: httpProxy,
  accessLog: AccessLogContext,
): Promise<void> {
  const token = url.searchParams.get('token');
  const state = url.searchParams.get('state');

  if (!token || !state) {
    accessLog.outcome = 'auth_callback_bad_request';
    logger.warn('Missing token or state in callback');
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Bad Request: Missing parameters');
    return;
  }

  const stateData = await validateState(state);

  if (!stateData) {
    // State not found locally. For nested preview topologies, the state may have
    // been created by an inner preview-proxy, so attempt nested-only forwarding.
    const suffix = config.PREVIEW_PROXY_SUBDOMAIN_SUFFIX;
    const host = suffix
      ? (req.headers['x-roomote-forwarded-host'] as string) || req.headers.host
      : req.headers.host;

    if (host && !suffix) {
      const nestedResolution = await tryNestedFallback(host, 'Auth callback');
      if (
        nestedResolution?.status === 'active' &&
        nestedResolution.sandboxUrl
      ) {
        req.headers['x-roomote-forwarded-host'] = host;
        const forwardedProto = req.headers['x-forwarded-proto'];
        req.headers['x-roomote-forwarded-proto'] =
          typeof forwardedProto === 'string'
            ? forwardedProto.split(',')[0]?.trim() || 'https'
            : 'https';

        logger.info(
          {
            state: escapeForLog(state.substring(0, 8)),
            host: escapeForLog(host),
            sandboxUrl: escapeForLog(nestedResolution.sandboxUrl),
          },
          'Forwarding auth callback to nested preview-proxy',
        );

        accessLog.outcome = 'auth_callback_forwarded_nested';
        accessLog.upstreamTarget = nestedResolution.sandboxUrl;
        proxyRequest(proxy, req, res, nestedResolution.sandboxUrl, (err) => {
          accessLog.outcome = 'auth_callback_proxy_error';
          accessLog.upstreamError = err.message;
          logger.error(
            { err, host: escapeForLog(host) },
            'Proxy error on callback forward',
          );
          if (!res.headersSent) {
            res.writeHead(502);
            res.end('Bad Gateway');
          }
        });
        return;
      }
    }

    accessLog.outcome = 'auth_callback_invalid_state';
    logger.warn(
      { state: escapeForLog(state.substring(0, 8)) },
      'Invalid or expired state in callback',
    );
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Bad Request: Invalid or expired state');
    return;
  }

  const tokenData = await validateToken(token);

  if (!tokenData) {
    accessLog.outcome = 'auth_callback_invalid_token';
    logger.warn('Invalid token in callback');
    res.writeHead(401, { 'Content-Type': 'text/plain' });
    res.end('Unauthorized: Invalid token');
    return;
  }

  // Token is user-scoped (not task-specific), so no taskId mismatch check is needed.
  // User validation happens in the auth middleware when accessing the preview.

  // Set cookie on the base domain so it works across all preview subdomains
  const cookieDomain = await getCookieDomain();
  const secure = shouldSetSecure(req);

  const setCookieValue = buildSetCookieHeader(
    config.PREVIEW_AUTH_COOKIE_NAME,
    token,
    {
      httpOnly: true,
      secure,
      sameSite: 'None',
      maxAge: parseInt(config.PREVIEW_TOKEN_TTL_SECONDS),
      path: '/',
      domain: cookieDomain,
      partitioned: true,
    },
  );

  logger.info(
    {
      userId: escapeForLog(tokenData.userId),
      domain: cookieDomain ?? 'not-set',
    },
    'Auth callback successful',
  );

  accessLog.outcome = 'auth_callback_success';

  // Set Referrer-Policy header to prevent token leakage via referrer headers
  res.writeHead(302, {
    'Set-Cookie': setCookieValue,
    'Referrer-Policy': 'no-referrer',
    Location: stateData.redirectUri,
  });
  res.end();
}
