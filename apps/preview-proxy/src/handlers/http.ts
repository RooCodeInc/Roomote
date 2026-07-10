import type { IncomingMessage, ServerResponse } from 'http';
import type httpProxy from 'http-proxy';
import { DEFAULT_AUTH_BYPASS_HEADER_NAME } from '@roomote/types';
import { stripSuffixFromHost, parseHostForConfig } from '../lib/url-parser';
import {
  resolveRequest,
  type ResolvedRequest,
  type ResolverIdentifier,
} from '../services/resolver';
import { tryNestedFallback } from '../lib/nested-routing';
import { validateAuthCookieForTaskRun, storeState } from '../services/auth';
import * as redis from '../lib/redis';
import { buildSetCookieHeader, getCookieDomain } from '../lib/cookies';
import { proxyRequest } from '../lib/proxy';
import {
  render404Page,
  renderCompletedPage,
  renderResumingPage,
  renderUnavailablePage,
} from '../lib/error-pages';
import { triggerAutoResume } from './auto-resume';
import { isLoopbackHostname } from '@roomote/types';
import { logger, escapeForLog } from '../lib/logger';
import { config } from '../config';
import type { AccessLogContext } from '../lib/access-log';
import { getRequestContext, setRequestContext } from '../lib/request-context';

/**
 * Extract cookie value from request headers.
 */
function getCookie(req: IncomingMessage, name: string): string | undefined {
  const cookies = req.headers.cookie;
  if (!cookies) return undefined;

  const match = cookies
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${name}=`));

  return match ? match.slice(name.length + 1) : undefined;
}

/**
 * Filter out a named cookie from the cookie header.
 * Other cookies are allowed through since sandboxes may have their own auth.
 */
function filterCookie(cookieHeader: string, name: string): string {
  return cookieHeader
    .split(';')
    .map((c) => c.trim())
    .filter((c) => !c.startsWith(`${name}=`))
    .join('; ');
}

function applyTrustedAuthProxyBypassHeader(
  req: IncomingMessage,
  resolution: Pick<
    ResolvedRequest,
    'authBypassHeaderName' | 'authBypassHeaderValue' | 'hasAuthProxy'
  >,
): void {
  if (!resolution.hasAuthProxy || !resolution.authBypassHeaderValue) {
    return;
  }

  req.headers[
    resolution.authBypassHeaderName ?? DEFAULT_AUTH_BYPASS_HEADER_NAME
  ] = resolution.authBypassHeaderValue;
}

/**
 * Check if a request is a browser navigation (vs fetch/XHR/resource load).
 * Uses Sec-Fetch-Mode header which is set by modern browsers.
 */
function isNavigationRequest(req: IncomingMessage): boolean {
  const secFetchMode = req.headers['sec-fetch-mode'];

  // 'navigate' = top-level navigation (address bar, link clicks)
  // 'nested-navigate' = iframe/frame navigation
  if (secFetchMode === 'navigate' || secFetchMode === 'nested-navigate') {
    return true;
  }

  // Fallback for older browsers
  if (!secFetchMode) {
    const accept = req.headers.accept || '';
    return accept.includes('text/html');
  }

  return false;
}

function getRequestProtocol(req: IncomingMessage): string {
  const forwardedProto = req.headers['x-forwarded-proto'];
  if (typeof forwardedProto === 'string' && forwardedProto.length > 0) {
    // Can be a comma-separated list, take first (closest client)
    return forwardedProto.split(',')[0]!.trim();
  }

  return config.NODE_ENV === 'production' ? 'https' : 'http';
}

/**
 * Determine if the Secure flag should be set on the cookie.
 * With SameSite=None, browsers silently reject cookies without Secure on
 * non-localhost HTTPS origins.
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
 * Build the auth redirect URL for a request that needs authentication.
 * Auth redirects are keyed by task_id.
 */
function buildAuthRedirectUrl(
  host: string,
  protocol: string,
  taskId: string,
  state: string,
): string {
  const redirectUri = `${protocol}://${host}/auth/callback`;

  const authUrl = new URL('/api/auth/preview', config.R_APP_URL);
  authUrl.searchParams.set('task_id', taskId);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('redirect_uri', redirectUri);

  return authUrl.toString();
}

function buildCorsHeaders(req: IncomingMessage): Record<string, string> {
  const origin = req.headers.origin;
  const headers: Record<string, string> = {};
  if (typeof origin === 'string' && origin.length > 0) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Credentials'] = 'true';
    headers['Vary'] = 'Origin';
  }
  return headers;
}

// Response helpers
function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function sendJson(
  res: ServerResponse,
  req: IncomingMessage,
  status: number,
  data: object,
): void {
  const headers = {
    'Content-Type': 'application/json',
    ...buildCorsHeaders(req),
  };
  res.writeHead(status, headers);
  res.end(JSON.stringify(data));
}

function sendRedirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { Location: location });
  res.end();
}

const AUTH_REQUIRED_PAYLOAD = {
  error: 'Authentication required',
  code: 'AUTH_REQUIRED',
  message: 'This preview requires authentication.',
};

/**
 * Escape a string for safe interpolation into HTML attributes.
 * Prevents XSS from attacker-controlled query parameters.
 */
function escapeHtmlAttr(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * HTML page served when __preview_token redirect detected but cookie was
 * rejected by the browser (e.g. Safari < 18.4 blocking third-party cookies).
 */
function renderCookieBlockedPage(previewUrl: string): string {
  const safeUrl = escapeHtmlAttr(previewUrl);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authentication Required</title>
  <style>
    body { font-size: 14px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #f1f2ee; color: #333; }
    .container { text-align: left; max-width: 480px; padding: 2rem; }
    h1 { font-size: 1.25rem; margin-bottom: 0.5rem; }
    p { color: #666; line-height: 1.5; }
    a.btn { display: inline-block; margin-top: 1rem; padding: 0.5rem 1rem; background: #000; color: #fff; text-decoration: none; border-radius: 6px; font-weight: 500; }
    a.btn:hover { color: #cfef53; }
  </style>
</head>
<body>
  <div class="container">
    <svg width="23" height="23" viewBox="0 0 23 23" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M7.5 7.50977V7.5C7.5 6.94772 7.94772 6.5 8.5 6.5C9.05228 6.5 9.5 6.94772 9.5 7.5V7.50977C9.5 8.06205 9.05228 8.50977 8.5 8.50977C7.94772 8.50977 7.5 8.06205 7.5 7.50977Z" fill="black"/>
      <path d="M15 14.5098V14.5C15 13.9477 15.4477 13.5 16 13.5C16.5523 13.5 17 13.9477 17 14.5V14.5098C17 15.0621 16.5523 15.5098 16 15.5098C15.4477 15.5098 15 15.0621 15 14.5098Z" fill="black"/>
      <path d="M11 11.0098V11C11 10.4477 11.4477 10 12 10C12.5523 10 13 10.4477 13 11V11.0098C13 11.5621 12.5523 12.0098 12 12.0098C11.4477 12.0098 11 11.5621 11 11.0098Z" fill="black"/>
      <path d="M10 16.0098V16C10 15.4477 10.4477 15 11 15C11.5523 15 12 15.4477 12 16V16.0098C12 16.5621 11.5523 17.0098 11 17.0098C10.4477 17.0098 10 16.5621 10 16.0098Z" fill="black"/>
      <path d="M6 13.0098V13C6 12.4477 6.44772 12 7 12C7.55228 12 8 12.4477 8 13V13.0098C8 13.5621 7.55228 14.0098 7 14.0098C6.44772 14.0098 6 13.5621 6 13.0098Z" fill="black"/>
      <path d="M17.8333 7.4082C17.846 7.57354 17.8712 7.73827 17.9114 7.90039C18.0429 8.42955 18.3159 8.91328 18.7015 9.29883C19.087 9.68431 19.5708 9.95744 20.0999 10.0889C20.6291 10.2202 21.1852 10.2044 21.7063 10.0439C22.0094 9.95087 22.3389 10.0071 22.594 10.1953C22.8492 10.3839 23.0003 10.6827 23.0003 11C23.0003 13.1755 22.3554 15.3024 21.1468 17.1113C19.9382 18.9201 18.22 20.3305 16.2102 21.1631C14.2005 21.9955 11.9883 22.2133 9.85478 21.7891C8.24333 21.4685 6.73076 20.7918 5.42411 19.8174L6.85673 18.3848C7.87001 19.0903 9.02231 19.5841 10.2444 19.8271C11.9902 20.1743 13.8002 19.9956 15.4446 19.3145C17.0889 18.6332 18.4949 17.4799 19.4837 16C20.2535 14.8477 20.7418 13.5374 20.9212 12.1738C20.4845 12.1824 20.0462 12.1364 19.6184 12.0303C18.7363 11.8113 17.9301 11.3556 17.2874 10.7129C16.8118 10.2373 16.4394 9.67185 16.1888 9.05273L17.8333 7.4082ZM4.71513 16.2842C4.99213 16.6661 5.29954 17.0278 5.63603 17.3643C5.77432 17.5025 5.91741 17.6352 6.06376 17.7637L4.64774 19.1797C4.5029 19.0495 4.36017 18.9165 4.22196 18.7783C3.88617 18.4425 3.57507 18.0854 3.28739 17.7119L4.71513 16.2842ZM12.0003 0C12.3176 9.79856e-05 12.6165 0.151015 12.805 0.40625C12.9931 0.661371 13.0495 0.990923 12.9563 1.29395C12.7958 1.81519 12.78 2.37107 12.9114 2.90039C13.0429 3.42955 13.3159 3.91328 13.7015 4.29883C13.9741 4.57143 14.2966 4.78574 14.6487 4.93555L13.1712 6.41309C12.8529 6.21382 12.5553 5.98074 12.2874 5.71289C11.6447 5.07016 11.189 4.26401 10.97 3.38184C10.8637 2.95363 10.8168 2.51522 10.8255 2.07812C9.46221 2.25764 8.15229 2.74694 7.00028 3.5166C5.52037 4.50545 4.36704 5.91131 3.68583 7.55566C3.00464 9.2002 2.82587 11.01 3.17314 12.7559C3.36026 13.6965 3.69622 14.5954 4.16239 15.4219L2.70439 16.8809C1.98501 15.7437 1.47638 14.4785 1.21122 13.1455C0.786931 11.0119 1.00471 8.79985 1.8372 6.79004C2.66978 4.7802 4.08012 3.06214 5.88896 1.85352C7.69783 0.644959 9.82482 9.42602e-07 12.0003 0ZM16.7063 5.04395C17.0602 4.93525 17.4455 5.03117 17.7073 5.29297C17.8588 5.44449 17.9528 5.63769 17.9856 5.8418L15.8841 7.94336C15.8453 7.68816 15.8253 7.43103 15.8255 7.17383C15.4206 7.17402 15.015 7.12868 14.6184 7.03027C14.4498 6.98841 14.2848 6.93478 14.1224 6.87598L15.8235 5.1748C16.1214 5.1746 16.4193 5.13234 16.7063 5.04395Z" fill="black"/>
      <path d="M0.707096 20.2927C0.316572 20.6832 0.316571 21.3164 0.707096 21.7069C1.09762 22.0975 1.73079 22.0975 2.12131 21.7069L21.7069 2.12132C22.0974 1.7308 22.0974 1.09763 21.7069 0.707107C21.3164 0.316583 20.6832 0.316583 20.2927 0.707107L0.707096 20.2927Z" fill="#B20000"/>
    </svg>

    <h1>Blocked Cookie</h1>
    <p>Your browser blocked the cookie needed for side pane previews.</p>
    <p>This is common with Firefox, Safari or browsers that restrict third-party cookies. It works with no problem on Chrome.</p>
    <p>Open this preview in a new tab to continue. A Chromium-based browser is the most reliable option for embedded previews.</p>
    <a class="btn" href="${safeUrl}" target="_blank" rel="noopener">Open Preview in New Tab</a>
  </div>
  <script>
    (function() {
      function notifyParent() {
        if (window.parent === window) return;
        window.parent.postMessage(
          {
            type: 'roomote-navigation',
            url: window.location.href,
            canGoBack: window.history.length > 1,
          },
          '*',
        );
        window.parent.postMessage({ type: 'roomote-load-complete' }, '*');
      }

      if (document.readyState === 'complete') {
        notifyParent();
      } else {
        window.addEventListener('load', notifyParent, { once: true });
      }
    })();
  </script>
</body>
</html>`;
}

/**
 * Handle redirect_to_direct status: validate auth, then redirect to direct sandbox URL.
 * This is used for unproxied ports where we want to enforce auth before revealing
 * the direct sandbox URL.
 */
async function handleRedirectToDirect(
  req: IncomingMessage,
  res: ServerResponse,
  host: string,
  resolution: ResolvedRequest,
): Promise<void> {
  // Check auth if required
  if (resolution.requiresAuth && resolution.taskRun) {
    const authCookie = getCookie(req, config.PREVIEW_AUTH_COOKIE_NAME);
    const authResult = await validateAuthCookieForTaskRun(
      authCookie,
      resolution.taskRun,
    );

    if (!authResult.valid) {
      if (isNavigationRequest(req)) {
        if (resolution.taskId) {
          const state = crypto.randomUUID();
          const protocol = getRequestProtocol(req);
          const originalUrl = `${protocol}://${host}${req.url || '/'}`;
          await storeState(state, originalUrl, resolution.taskRun.id);

          const authUrl = buildAuthRedirectUrl(
            host,
            protocol,
            resolution.taskId,
            state,
          );
          sendRedirect(res, authUrl);
        } else {
          res.writeHead(500);
          res.end('Internal Error: No task ID available');
        }
      } else {
        sendJson(res, req, 401, AUTH_REQUIRED_PAYLOAD);
      }
      return;
    }
  }

  // Auth valid (or not required) - redirect to direct sandbox URL
  logger.info(
    {
      host: escapeForLog(host),
      directUrl: escapeForLog(resolution.directUrl!),
    },
    'Redirecting to direct sandbox URL for unproxied port',
  );
  sendRedirect(res, resolution.directUrl!);
}

/**
 * Handle resumable status: auto-resume sandbox from snapshot if authenticated.
 * Shows a progress page that polls for run status and redirects when ready.
 */
async function handleResumableRequest(
  req: IncomingMessage,
  res: ServerResponse,
  host: string,
  resolution: ResolvedRequest,
  displayId: string,
): Promise<void> {
  // Always require auth for auto-resume
  if (!resolution.taskRun) {
    sendHtml(res, 410, renderCompletedPage(displayId));
    return;
  }

  const authCookie = getCookie(req, config.PREVIEW_AUTH_COOKIE_NAME);
  const authResult = await validateAuthCookieForTaskRun(
    authCookie,
    resolution.taskRun,
  );

  if (!authResult.valid || !authResult.token) {
    // Not authenticated - redirect to auth flow
    if (isNavigationRequest(req)) {
      if (resolution.taskId) {
        const state = crypto.randomUUID();
        const protocol = getRequestProtocol(req);
        const originalUrl = `${protocol}://${host}${req.url || '/'}`;
        await storeState(state, originalUrl, resolution.taskRun.id);

        const authUrl = buildAuthRedirectUrl(
          host,
          protocol,
          resolution.taskId,
          state,
        );
        sendRedirect(res, authUrl);
      } else {
        // No task ID is a data invariant violation — return 500 like other paths
        logger.error(
          { host: escapeForLog(host), displayId: escapeForLog(displayId) },
          'Resumable auth redirect failed: no task ID available',
        );
        res.writeHead(500);
        res.end('Internal Error: No task ID available');
      }
    } else {
      sendJson(res, req, 401, AUTH_REQUIRED_PAYLOAD);
    }
    return;
  }

  // User is authenticated - trigger auto-resume
  logger.info(
    {
      host: escapeForLog(host),
      taskId: resolution.taskId ? escapeForLog(resolution.taskId) : null,
      snapshotId: resolution.snapshotId
        ? escapeForLog(resolution.snapshotId)
        : null,
    },
    'Triggering auto-resume for resumable request',
  );

  const resumeResult = await triggerAutoResume(resolution, authResult.token);

  const resumeStatusId = resumeResult.newRunId?.toString();

  if (!resumeResult.success || !resumeStatusId) {
    // Failed to resume - show error
    logger.error(
      {
        error: resumeResult.error,
        taskId: resolution.taskId ? escapeForLog(resolution.taskId) : null,
      },
      'Auto-resume failed',
    );

    // For non-navigation requests, return JSON error
    if (!isNavigationRequest(req)) {
      sendJson(res, req, 500, {
        error: 'Resume failed',
        message: resumeResult.error || 'Failed to create resume task run',
      });
      return;
    }

    // For navigation, show completed page (resume not available)
    sendHtml(res, 410, renderCompletedPage(displayId));
    return;
  }

  // For non-navigation requests, return JSON with the resume status ID.
  if (!isNavigationRequest(req)) {
    sendJson(res, req, 202, {
      status: 'resuming',
      ...(resumeResult.newRunId ? { runId: resumeResult.newRunId } : {}),
      message:
        'Sandbox is being resumed. Poll /rooproxy/resume-status/' +
        resumeStatusId +
        ' for status.',
    });
    return;
  }

  // Show resuming progress page
  sendHtml(res, 200, renderResumingPage(displayId, resumeStatusId));
}

/**
 * Shared logic: auth check, cookie handling, header setup, and proxying.
 * Used by both the normal and nested paths.
 */
async function resolveAuthAndProxy(
  req: IncomingMessage,
  res: ServerResponse,
  proxy: httpProxy,
  host: string,
  resolution: ResolvedRequest,
  displayId: string,
  accessLog: AccessLogContext,
): Promise<void> {
  // Handle non-active states and special cases
  switch (resolution.status) {
    case 'redirect':
      accessLog.outcome = 'redirect';
      sendRedirect(res, resolution.redirectUrl!);
      return;
    case 'redirect_to_direct':
      accessLog.outcome = 'redirect_to_direct';
      await handleRedirectToDirect(req, res, host, resolution);
      return;
    case 'gone':
      accessLog.outcome = 'gone';
      sendHtml(res, 410, renderCompletedPage(displayId));
      return;
    case 'resumable':
      accessLog.outcome = 'resumable';
      await handleResumableRequest(req, res, host, resolution, displayId);
      return;
    case 'sandbox_unavailable':
      accessLog.outcome = 'unavailable';
      sendHtml(res, 503, renderUnavailablePage(displayId));
      return;
    case 'not_found':
      accessLog.outcome = 'not_found';
      sendHtml(res, 404, render404Page(displayId));
      return;
  }

  // 3. Check for inline __preview_token (used by iframe trampoline)
  const requestUrl = new URL(req.url || '/', `http://${host}`);
  const inlineToken = requestUrl.searchParams.get('__preview_token');

  // Check for __preview_token_redirect failure detection:
  // The value is a nonce stored in Redis when we issued the redirect, preventing forgery.
  const tokenRedirectNonce = requestUrl.searchParams.get(
    '__preview_token_redirect',
  );
  if (tokenRedirectNonce) {
    const nonceKey = `preview:redirect_nonce:${tokenRedirectNonce}`;
    const nonceValid = await redis.get(nonceKey);
    if (nonceValid) {
      // Consume the nonce so it can't be replayed
      await redis.del(nonceKey);

      const authCookie = getCookie(req, config.PREVIEW_AUTH_COOKIE_NAME);
      if (!authCookie) {
        // Browser blocked the Set-Cookie from __preview_token redirect.
        // Serve fallback UX page.
        requestUrl.searchParams.delete('__preview_token_redirect');
        const protocol = getRequestProtocol(req);
        const cleanUrl = `${protocol}://${host}${requestUrl.pathname}${requestUrl.search}`;
        accessLog.outcome = 'cookie_blocked_fallback';
        sendHtml(res, 200, renderCookieBlockedPage(cleanUrl));
        return;
      }
    }
    // Nonce invalid/missing (forged or expired) or cookie set successfully — strip and continue
    requestUrl.searchParams.delete('__preview_token_redirect');
    req.url = requestUrl.pathname + requestUrl.search;
  }

  if (inlineToken && resolution.taskRun) {
    const tokenResult = await validateAuthCookieForTaskRun(
      inlineToken,
      resolution.taskRun,
    );

    if (tokenResult.valid && tokenResult.token) {
      // Strip the token from the URL and add a nonce-based redirect detection flag.
      // The nonce is stored in Redis so forged query params are rejected.
      const redirectNonce = crypto.randomUUID();
      await redis.setWithExpiry(
        `preview:redirect_nonce:${redirectNonce}`,
        '1',
        60,
      );
      requestUrl.searchParams.delete('__preview_token');
      requestUrl.searchParams.set('__preview_token_redirect', redirectNonce);
      const protocol = getRequestProtocol(req);
      const cleanUrl = `${protocol}://${host}${requestUrl.pathname}${requestUrl.search}`;

      // Set preview_auth cookie (replaces old preview_session)
      const secure = shouldSetSecure(req);
      const cookieDomain = await getCookieDomain();
      const cookieValue = buildSetCookieHeader(
        config.PREVIEW_AUTH_COOKIE_NAME,
        inlineToken,
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

      accessLog.outcome = 'token_redirect';
      res.writeHead(302, {
        Location: cleanUrl,
        'Set-Cookie': cookieValue,
      });
      res.end();

      logger.debug(
        { host: escapeForLog(host) },
        'Validated inline preview token, redirecting with auth cookie',
      );
      return;
    } else {
      // Invalid token - strip it and fall through to normal auth
      requestUrl.searchParams.delete('__preview_token');
      req.url = requestUrl.pathname + requestUrl.search;
    }
  }

  // 3b. Check bypass escape hatches before auth
  let requiresAuth = resolution.requiresAuth;

  // Path-prefix bypass: skip auth for requests matching configured path prefixes
  if (requiresAuth && resolution.authBypassPaths) {
    const pathname = new URL(req.url || '/', `http://${host}`).pathname;
    if (
      resolution.authBypassPaths.some((prefix) => pathname.startsWith(prefix))
    ) {
      requiresAuth = false;
      logger.debug(
        { host: escapeForLog(host), pathname },
        'Auth bypassed via path prefix',
      );
    }
  }

  // Header bypass: skip auth when request includes the correct bypass header value
  if (requiresAuth && resolution.authBypassHeaderValue) {
    const bypassHeader =
      resolution.authBypassHeaderName ?? DEFAULT_AUTH_BYPASS_HEADER_NAME;
    const headerVal = req.headers[bypassHeader];
    const cookieVal = getCookie(req, bypassHeader);
    if (
      headerVal === resolution.authBypassHeaderValue ||
      cookieVal === resolution.authBypassHeaderValue
    ) {
      requiresAuth = false;
      logger.debug(
        { host: escapeForLog(host) },
        'Auth bypassed via header/cookie',
      );
    }
  }

  // 3c. Check auth if required
  const previewAuthCookie = getCookie(req, config.PREVIEW_AUTH_COOKIE_NAME);
  const authResult =
    requiresAuth && resolution.taskRun
      ? await validateAuthCookieForTaskRun(
          previewAuthCookie,
          resolution.taskRun,
        )
      : null;

  if (requiresAuth && resolution.taskRun) {
    if (!authResult?.valid) {
      if (isNavigationRequest(req)) {
        if (resolution.taskId) {
          accessLog.outcome = 'auth_redirect';
          const state = crypto.randomUUID();
          const protocol = getRequestProtocol(req);
          const originalUrl = `${protocol}://${host}${req.url || '/'}`;
          await storeState(state, originalUrl, resolution.taskRun.id);

          const authUrl = buildAuthRedirectUrl(
            host,
            protocol,
            resolution.taskId,
            state,
          );
          sendRedirect(res, authUrl);
        } else {
          accessLog.outcome = 'error';
          res.writeHead(500);
          res.end('Internal Error: No task ID available');
        }
      } else {
        accessLog.outcome = 'auth_denied';
        sendJson(res, req, 401, AUTH_REQUIRED_PAYLOAD);
      }
      return;
    }
  }

  const protocol = getRequestProtocol(req);

  applyTrustedAuthProxyBypassHeader(req, resolution);

  // Handle auth cookie forwarding based on hasAuthProxy
  // Forward preview_auth ONLY when an auth-proxy instance sits in front of this port.
  // Otherwise, filter it out to prevent leakage to application backends.
  const originalCookie = req.headers.cookie;
  if (resolution.hasAuthProxy) {
    // Keep preview_auth for sandbox auth-proxy validation
    // No preview_session to filter anymore
  } else if (originalCookie) {
    const filteredCookie = filterCookie(
      originalCookie,
      config.PREVIEW_AUTH_COOKIE_NAME,
    );
    if (filteredCookie) {
      req.headers.cookie = filteredCookie;
    } else {
      delete req.headers.cookie;
    }
  }

  // Set forwarding headers
  const xForwardedFor =
    (req.headers['x-forwarded-for'] as string) ||
    (req.headers['cf-connecting-ip'] as string) ||
    req.socket.remoteAddress ||
    '';

  // In inner mode, strip the suffix from the host for forwarding headers.
  // The inner sandbox's auth-proxy expects the inner-only hostname
  // (e.g., "ug61pirkutxl-editor.preview.roomote.run"), not the full nested
  // hostname with the outer suffix still attached.
  const suffix = config.PREVIEW_PROXY_SUBDOMAIN_SUFFIX;
  const forwardHost = suffix ? stripSuffixFromHost(host, suffix) : host;

  // Set Roomote-specific forwarding headers for sandbox auth-proxy.
  // These are preferred over x-forwarded-* headers when building redirect/callback URLs.
  req.headers['x-roomote-forwarded-host'] = forwardHost;
  // Preserve the original public host separately so downstream apps can
  // generate canonical redirects without
  // breaking nested routing, which depends on the stripped host above.
  if (suffix) {
    req.headers['x-roomote-public-host'] = host;
  } else {
    delete req.headers['x-roomote-public-host'];
  }
  req.headers['x-roomote-forwarded-proto'] = protocol;

  // Standard forwarding headers for compatibility
  req.headers['x-forwarded-for'] = xForwardedFor;
  req.headers['x-forwarded-proto'] = 'https';
  req.headers['x-forwarded-host'] = forwardHost;

  const requestContext = getRequestContext();
  if (requestContext) {
    req.headers['x-request-id'] = requestContext.requestId;
    req.headers.traceparent = requestContext.traceparent;
  }

  if (
    (req as IncomingMessage & { __dropTracestate?: boolean }).__dropTracestate
  ) {
    delete req.headers.tracestate;
  }

  accessLog.outcome = 'proxied';
  accessLog.upstreamTarget = resolution.sandboxUrl!;
  setRequestContext({
    taskId: resolution.taskId,
    runId: resolution.taskRun?.id,
    upstreamTarget: resolution.sandboxUrl!,
    outcome: accessLog.outcome,
  });

  logger.debug(
    {
      host: escapeForLog(host),
      target: escapeForLog(resolution.sandboxUrl!),
    },
    'Routing request to sandbox',
  );

  // Proxy the request - all async work is done
  proxyRequest(proxy, req, res, resolution.sandboxUrl!, (err) => {
    accessLog.outcome = 'proxy_error';
    accessLog.upstreamError = err.message;
    logger.error({ err, host: escapeForLog(host) }, 'Proxy error');
    if (!res.headersSent) {
      res.writeHead(502);
      res.end('Bad Gateway');
    }
  });
}

/**
 * Handle an HTTP request.
 * Performs all async operations before proxying.
 *
 * Supports nested preview-proxy URLs:
 * - Inner mode (suffix configured): strips suffix from hostname before parsing
 * - Outer mode (no suffix): on not_found, tries nested URL parsing to route
 *   through a wildcard_prefix port on an outer sandbox
 */
export async function handleHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  proxy: httpProxy,
  accessLog: AccessLogContext,
): Promise<void> {
  // In inner mode (suffix configured), prefer x-roomote-forwarded-host over
  // the host header. The sandbox auth-proxy rewrites host to a loopback
  // address (e.g. localhost:8081), but preserves the original public
  // hostname in x-roomote-forwarded-host.
  const host = config.PREVIEW_PROXY_SUBDOMAIN_SUFFIX
    ? (req.headers['x-roomote-forwarded-host'] as string) || req.headers.host
    : req.headers.host;
  if (!host) {
    accessLog.outcome = 'bad_request';
    res.writeHead(400);
    res.end('Bad Request: Missing host header');
    return;
  }

  const suffix = config.PREVIEW_PROXY_SUBDOMAIN_SUFFIX;
  const parsed = parseHostForConfig(host, suffix);

  let resolution: ResolvedRequest | null = null;
  let displayId = '';

  if (parsed.isValid) {
    const { portName, taskId } = parsed;
    const identifier: ResolverIdentifier = { taskId: taskId! };

    // 1. Resolve sandbox URL and request context
    resolution = await resolveRequest(identifier, portName);
    displayId = taskId!;

    // 2. In outer mode, if not_found, try nested URL fallback
    if (resolution.status === 'not_found' && !suffix) {
      const nestedResolution = await tryNestedFallback(host, 'HTTP');
      if (nestedResolution) {
        resolution = nestedResolution;
        displayId = `nested-${host.split('.')[0]}`;
      }
    }
  } else if (!suffix) {
    // In outer mode, try nested URL parsing before rejecting.
    // Nested URLs like {inner}-{port}-{outer}-{port}.domain may not parse
    // via the normal parseHost path (e.g. if the inner ID is not a valid
    // valid taskId from this proxy's perspective).
    resolution = await tryNestedFallback(host, 'HTTP');
    displayId = `nested-${host.split('.')[0]}`;
  }

  if (!resolution) {
    accessLog.outcome = 'bad_request';
    res.writeHead(400);
    res.end('Bad Request: Invalid host format');
    return;
  }

  // 3. Handle via shared auth+proxy logic
  await resolveAuthAndProxy(
    req,
    res,
    proxy,
    host,
    resolution,
    displayId,
    accessLog,
  );
}
