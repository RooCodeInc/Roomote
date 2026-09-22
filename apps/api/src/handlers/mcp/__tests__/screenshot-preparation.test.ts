import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Variables } from '../../../types';
import { mcpAuthMiddleware } from '../middleware';
import { screenshotPreparationRoute } from '../screenshot-preparation';

const mocks = vi.hoisted(() => ({
  prepareScreenshotStep: vi.fn(),
}));

vi.mock('@roomote/env', () => ({
  Env: { R_SCREENSHOT_PREPARATION_JEV_ENABLED: true },
}));

vi.mock('@roomote/cloud-agents/server/screenshot-preparation', () => ({
  prepareScreenshotStep: mocks.prepareScreenshotStep,
}));

function createApp() {
  const app = new Hono<{ Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('authContext', {
      tokenType: 'run',
      runId: 'run-1',
      taskId: 'task-1',
      userId: null,
    } as never);
    await next();
  });
  app.use('*', mcpAuthMiddleware);
  app.route('/', screenshotPreparationRoute);
  return app;
}

const nextRequest = {
  operation: 'next',
  optIn: true,
  evidenceGoal: 'Show the settings state.',
  page: {
    url: 'http://localhost:3000/settings',
    title: 'Settings',
    visibleText: 'Settings',
    viewport: {
      width: 1280,
      height: 800,
      scrollX: 0,
      scrollY: 0,
      documentWidth: 1280,
      documentHeight: 800,
    },
    controls: [],
  },
  allowedActions: [{ id: 'capture', kind: 'capture-ready' }],
};

describe('screenshot preparation route', () => {
  beforeEach(() => {
    mocks.prepareScreenshotStep.mockReset();
    mocks.prepareScreenshotStep.mockResolvedValue({
      status: 'fallback',
      reason: 'judgment_unconfigured',
      metrics: { actionsUsed: 0 },
    });
  });

  it('requires a task run token', async () => {
    const app = new Hono<{ Variables: Variables }>();
    app.use('*', mcpAuthMiddleware);
    app.route('/', screenshotPreparationRoute);

    const response = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(nextRequest),
    });

    expect(response.status).toBe(401);
    expect(mocks.prepareScreenshotStep).not.toHaveBeenCalled();
  });

  it('forwards a validated observation through the authenticated task route', async () => {
    const response = await createApp().request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(nextRequest),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: 'fallback',
      reason: 'judgment_unconfigured',
    });
    expect(mocks.prepareScreenshotStep).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-1',
        enabled: true,
      }),
    );
    expect(mocks.prepareScreenshotStep.mock.calls[0]![0].input).toMatchObject(
      nextRequest,
    );
  });

  it('rejects malformed structured page state before calling Jev', async () => {
    const response = await createApp().request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...nextRequest,
        page: { title: 'missing fields' },
      }),
    });

    expect(response.status).toBe(400);
    expect(mocks.prepareScreenshotStep).not.toHaveBeenCalled();
  });
});
