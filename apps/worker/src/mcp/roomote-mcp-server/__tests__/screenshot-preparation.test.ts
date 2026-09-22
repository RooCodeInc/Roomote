import { afterEach, describe, expect, it, vi } from 'vitest';

import { handlePrepareScreenshot } from '../screenshot-preparation';

const config = {
  token: 'run-token',
  platformApiUrl: 'https://roomote.example',
};

const request = {
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

describe('handlePrepareScreenshot', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('proxies the opt-in observation through the authenticated Roomote API', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        status: 'ready',
        loopId: '1a0f6e1d-e2d7-4b88-93bb-7bb8abdb2a0e',
        action: { id: 'capture', kind: 'capture-ready' },
        metrics: { actionsUsed: 1 },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await handlePrepareScreenshot(request, config);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://roomote.example/api/mcp/screenshot-preparation',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer run-token',
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify(request),
      }),
    );
    expect(result.content[0]!.text).toContain('"status":"ready"');
  });
});
