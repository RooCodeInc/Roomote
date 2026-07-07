import { basicAuth } from 'hono/basic-auth';
import type { MiddlewareHandler } from 'hono';

/**
 * Decide how the BullMQ `/admin` queue dashboard should be protected.
 *
 * The dashboard exposes Bull Board with write access to every queue, so it must
 * never be served unauthenticated. Access is gated purely on whether a
 * dashboard password is configured — never on `NODE_ENV`, because the self-host
 * stack runs most services (including this one) with `NODE_ENV=development`, and
 * an environment-based skip would leave the dashboard wide open there.
 *
 * When no password is configured we fail closed (refuse to serve `/admin`)
 * rather than exposing the queues; the queue workers keep running regardless.
 */
type AdminDashboardAuth =
  | { mode: 'basic-auth'; username: string; password: string }
  | { mode: 'unavailable' };

export const ADMIN_DASHBOARD_USERNAME = 'admin';

/**
 * Operational `/admin` paths that never grant queue access and must stay
 * reachable without dashboard credentials. The `pnpm dev` doctor probes
 * `/admin/health` unauthenticated (`apps/dev/src/doctor.ts`), and external
 * health/monitoring tooling may do the same; the dashboard port is published to
 * `127.0.0.1` only (or not at all under the production Caddy overlay), so this
 * does not expose the health endpoint off-host.
 */
const PUBLIC_ADMIN_DASHBOARD_PATHS = new Set(['/admin/health']);

export function isPublicAdminDashboardPath(path: string): boolean {
  return PUBLIC_ADMIN_DASHBOARD_PATHS.has(path);
}

export function resolveAdminDashboardAuth(
  password: string | undefined,
): AdminDashboardAuth {
  if (password) {
    return {
      mode: 'basic-auth',
      username: ADMIN_DASHBOARD_USERNAME,
      password,
    };
  }

  return { mode: 'unavailable' };
}

/**
 * Build the Hono middleware that protects the `/admin` surface.
 *
 * Bull Board (mounted at `/admin/queues`) has write access to every queue, so
 * it requires basic auth when a password is configured and fails closed with
 * `503` otherwise. The operational paths in
 * {@link PUBLIC_ADMIN_DASHBOARD_PATHS} are exempt so health probes keep working
 * even when the dashboard is locked down or disabled.
 */
export function createAdminDashboardMiddleware(
  auth: AdminDashboardAuth,
): MiddlewareHandler {
  const requireAuth =
    auth.mode === 'basic-auth'
      ? basicAuth({ username: auth.username, password: auth.password })
      : null;

  return async (c, next) => {
    if (isPublicAdminDashboardPath(c.req.path)) {
      return next();
    }

    if (requireAuth) {
      return requireAuth(c, next);
    }

    // Fail closed: refuse to expose the dashboard without a password. Queue
    // workers keep running; only the /admin surface is disabled.
    return c.json({ error: 'dashboard_password_not_configured' }, 503);
  };
}
