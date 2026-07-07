import { renderHook } from '@testing-library/react';

import { usePreviewUrls } from '../use-preview-urls';

describe('usePreviewUrls', () => {
  const originalBaseUrl = process.env.NEXT_PUBLIC_PREVIEW_PROXY_BASE_URL;
  const originalSuffix = process.env.NEXT_PUBLIC_PREVIEW_PROXY_SUBDOMAIN_SUFFIX;

  beforeEach(() => {
    delete process.env.NEXT_PUBLIC_PREVIEW_PROXY_BASE_URL;
    delete process.env.NEXT_PUBLIC_PREVIEW_PROXY_SUBDOMAIN_SUFFIX;
  });

  afterEach(() => {
    if (originalBaseUrl !== undefined) {
      process.env.NEXT_PUBLIC_PREVIEW_PROXY_BASE_URL = originalBaseUrl;
    } else {
      delete process.env.NEXT_PUBLIC_PREVIEW_PROXY_BASE_URL;
    }

    if (originalSuffix !== undefined) {
      process.env.NEXT_PUBLIC_PREVIEW_PROXY_SUBDOMAIN_SUFFIX = originalSuffix;
    } else {
      delete process.env.NEXT_PUBLIC_PREVIEW_PROXY_SUBDOMAIN_SUFFIX;
    }
  });

  it('builds preview URLs for the available machine domains', () => {
    const { result } = renderHook(() =>
      usePreviewUrls({
        taskId: 'task-123',
        machineDomains: {
          EDITOR: 'https://editor.vercel.run',
          SANDBOX_SERVER: 'https://sandbox-server.vercel.run',
          WEB: 'https://web.vercel.run',
        },
      }),
    );

    expect(result.current.previewUrls).toMatchObject({
      EDITOR: expect.stringContaining(
        'http://task-123-editor.roomotepreview.localhost',
      ),
      SANDBOX_SERVER: expect.stringContaining(
        'http://task-123-sandbox-server.roomotepreview.localhost',
      ),
      WEB: expect.stringContaining(
        'http://task-123-web.roomotepreview.localhost',
      ),
    });
  });

  it('returns null when taskId is unavailable', () => {
    const { result } = renderHook(() =>
      usePreviewUrls({
        machineDomains: {
          WEB: 'https://web.vercel.run',
        },
      }),
    );

    expect(result.current.previewUrls).toBeNull();
  });

  it('uses WEB as the primary Live Preview target when available', () => {
    const { result } = renderHook(() =>
      usePreviewUrls({
        taskId: 'task-123',
        machineDomains: {
          SANDBOX_SERVER: 'https://sandbox-server.vercel.run',
          WEB: 'https://web.vercel.run',
          API: 'https://api.vercel.run',
        },
      }),
    );

    expect(result.current.previewUrl).toBe(
      'http://task-123-web.roomotepreview.localhost:18081',
    );
  });

  it('keeps an explicit primary port even when the name is system-managed', () => {
    const { result } = renderHook(() =>
      usePreviewUrls({
        taskId: 'task-123',
        machineDomains: {
          SANDBOX_SERVER: 'https://sandbox-server.vercel.run',
          WEB: 'https://web.vercel.run',
        },
        machineDomain: 'https://web.vercel.run',
        primaryPortName: 'WEB',
      }),
    );

    expect(result.current.previewUrl).toBe(
      'http://task-123-web.roomotepreview.localhost:18081',
    );
  });
});
