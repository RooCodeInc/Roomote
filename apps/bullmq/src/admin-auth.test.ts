import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import {
  ADMIN_DASHBOARD_USERNAME,
  createAdminDashboardMiddleware,
  isPublicAdminDashboardPath,
  resolveAdminDashboardAuth,
} from './admin-auth';

describe('resolveAdminDashboardAuth', () => {
  it('requires basic auth when a password is configured', () => {
    expect(resolveAdminDashboardAuth('s3cret')).toEqual({
      mode: 'basic-auth',
      username: ADMIN_DASHBOARD_USERNAME,
      password: 's3cret',
    });
  });

  it('fails closed when no password is configured', () => {
    expect(resolveAdminDashboardAuth(undefined)).toEqual({
      mode: 'unavailable',
    });
  });

  it('treats an empty password as unconfigured rather than serving open', () => {
    expect(resolveAdminDashboardAuth('')).toEqual({ mode: 'unavailable' });
  });
});

describe('isPublicAdminDashboardPath', () => {
  it('exempts /admin/health so the doctor health probe stays unauthenticated', () => {
    expect(isPublicAdminDashboardPath('/admin/health')).toBe(true);
  });

  it('does not exempt the Bull Board surface or stats endpoint', () => {
    expect(isPublicAdminDashboardPath('/admin/queues')).toBe(false);
    expect(isPublicAdminDashboardPath('/admin/queues/jobs')).toBe(false);
    expect(isPublicAdminDashboardPath('/admin/stats')).toBe(false);
  });
});

function buildTestApp(
  auth: ReturnType<typeof resolveAdminDashboardAuth>,
): Hono {
  const app = new Hono();
  app.use('/admin/*', createAdminDashboardMiddleware(auth));
  app.get('/admin/health', (c) => c.json({ status: 'ok' }));
  app.get('/admin/stats', (c) => c.json({ queues: {} }));
  app.get('/admin/queues', (c) => c.html('<html>bull board</html>'));
  return app;
}

describe('createAdminDashboardMiddleware', () => {
  it('keeps /admin/health open without credentials (doctor health probe)', async () => {
    const app = buildTestApp(resolveAdminDashboardAuth('s3cret'));
    const res = await app.request('/admin/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('requires basic auth for the Bull Board surface', async () => {
    const app = buildTestApp(resolveAdminDashboardAuth('s3cret'));
    const unauthenticated = await app.request('/admin/queues');
    expect(unauthenticated.status).toBe(401);

    const authed = await app.request('/admin/queues', {
      headers: {
        Authorization: `Basic ${btoa('admin:s3cret')}`,
      },
    });
    expect(authed.status).toBe(200);
  });

  it('requires basic auth for /admin/stats', async () => {
    const app = buildTestApp(resolveAdminDashboardAuth('s3cret'));
    const res = await app.request('/admin/stats');
    expect(res.status).toBe(401);
  });

  it('fails closed with 503 for protected paths when no password is configured', async () => {
    const app = buildTestApp(resolveAdminDashboardAuth(undefined));
    const queues = await app.request('/admin/queues');
    expect(queues.status).toBe(503);
    const stats = await app.request('/admin/stats');
    expect(stats.status).toBe(503);
  });

  it('still serves /admin/health when the dashboard is disabled (no password)', async () => {
    const app = buildTestApp(resolveAdminDashboardAuth(undefined));
    const res = await app.request('/admin/health');
    expect(res.status).toBe(200);
  });
});
