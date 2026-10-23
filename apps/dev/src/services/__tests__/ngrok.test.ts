import fs from 'fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { execa } from 'execa';

import { NgrokService } from '../ngrok';

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

vi.mock('ora', () => ({
  default: vi.fn(() => ({
    start: () => ({
      succeed: vi.fn(),
      warn: vi.fn(),
      fail: vi.fn(),
    }),
  })),
}));

describe('NgrokService.checkInstalled', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(execa).mockReset();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    process.env = originalEnv;
  });

  it('passes when ngrok is already installed', async () => {
    vi.mocked(execa).mockResolvedValue({} as Awaited<ReturnType<typeof execa>>);

    await expect(NgrokService.checkInstalled(false)).resolves.toBeUndefined();

    expect(execa).toHaveBeenCalledWith('ngrok', ['version']);
  });

  it('shows install guidance when ngrok is missing', async () => {
    vi.mocked(execa).mockRejectedValue(new Error('ngrok not found'));

    await expect(NgrokService.checkInstalled(false)).rejects.toThrow(
      'Please install ngrok manually:',
    );
    await expect(NgrokService.checkInstalled(false)).rejects.toThrow(
      'https://ngrok.com/download',
    );
  });
});

describe('NgrokService.resolvePublicUrl', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(execa).mockReset();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    process.env = originalEnv;
  });

  it('uses an explicit R_PUBLIC_URL without starting ngrok', async () => {
    process.env.R_PUBLIC_URL =
      'https://roomote.example.com/some/path?ignored=true';

    await expect(
      NgrokService.resolvePublicUrl({
        port: 13000,
        verbose: false,
      }),
    ).resolves.toEqual({
      autoNgrok: false,
      publicUrl: 'https://roomote.example.com',
    });

    expect(execa).not.toHaveBeenCalled();
  });

  it('starts a configured static ngrok web tunnel', async () => {
    vi.useFakeTimers();
    process.env.R_PUBLIC_URL = 'https://static-roomote.ngrok.app';
    let fetchCount = 0;
    vi.mocked(execa)
      .mockResolvedValueOnce({} as Awaited<ReturnType<typeof execa>>)
      .mockResolvedValueOnce({
        stdout: 'Valid configuration file at /tmp/ngrok.yml',
      } as Awaited<ReturnType<typeof execa>>)
      .mockResolvedValueOnce({
        stdout: 'Valid configuration file at /tmp/ngrok.yml',
      } as Awaited<ReturnType<typeof execa>>)
      .mockResolvedValueOnce({} as Awaited<ReturnType<typeof execa>>);
    vi.spyOn(fs, 'readFileSync').mockReturnValue(
      'authtoken: configured-token\n',
    );
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => {
        fetchCount += 1;

        return {
          ok: true,
          json: async () => ({
            tunnels:
              fetchCount > 11
                ? [
                    {
                      config: { addr: 'http://localhost:13000' },
                      public_url: 'https://static-roomote.ngrok.app',
                    },
                  ]
                : [],
          }),
        };
      }),
    );

    const resolution = NgrokService.resolvePublicUrl({
      port: 13000,
      verbose: false,
    });

    await vi.advanceTimersByTimeAsync(500);

    await expect(resolution).resolves.toEqual({
      autoNgrok: true,
      publicUrl: 'https://static-roomote.ngrok.app',
    });
    expect(execa).toHaveBeenLastCalledWith(
      'pm2',
      [
        'start',
        'ngrok',
        '--name',
        'roomote-web-ngrok',
        '--',
        'http',
        '13000',
        '--url=static-roomote.ngrok.app',
        '--log=stdout',
      ],
      {},
    );
  });

  it('reuses a configured static ngrok tunnel when it is already running', async () => {
    process.env.R_PUBLIC_URL = 'https://static-roomote.ngrok.app';
    vi.mocked(execa)
      .mockResolvedValueOnce({} as Awaited<ReturnType<typeof execa>>)
      .mockResolvedValueOnce({
        stdout: 'Valid configuration file at /tmp/ngrok.yml',
      } as Awaited<ReturnType<typeof execa>>)
      .mockResolvedValueOnce({
        stdout: 'Valid configuration file at /tmp/ngrok.yml',
      } as Awaited<ReturnType<typeof execa>>);
    vi.spyOn(fs, 'readFileSync').mockReturnValue(
      'authtoken: configured-token\n',
    );
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          tunnels: [
            {
              config: { addr: 'http://localhost:13000' },
              public_url: 'https://static-roomote.ngrok.app',
            },
          ],
        }),
      }),
    );

    await expect(
      NgrokService.resolvePublicUrl({
        port: 13000,
        verbose: false,
      }),
    ).resolves.toEqual({
      autoNgrok: true,
      publicUrl: 'https://static-roomote.ngrok.app',
    });

    expect(execa).not.toHaveBeenCalledWith(
      'pm2',
      expect.arrayContaining(['start', 'ngrok']),
      expect.anything(),
    );
  });

  it('requires R_PUBLIC_URL', async () => {
    await expect(
      NgrokService.resolvePublicUrl({
        port: 13000,
        verbose: false,
      }),
    ).rejects.toThrow('R_PUBLIC_URL is required');

    expect(execa).not.toHaveBeenCalled();
  });

  it.each(['headers', 'body'] as const)(
    'reuses a healthy inspector after an earlier inspector stalls its %s',
    async (stall) => {
      process.env.R_PUBLIC_URL = 'https://static-roomote.ngrok.app';
      vi.mocked(execa).mockResolvedValue({
        stdout: 'Valid configuration file at /tmp/ngrok.yml',
      } as Awaited<ReturnType<typeof execa>>);
      vi.spyOn(fs, 'readFileSync').mockReturnValue('authtoken: fixture');

      const slow = http.createServer((_request, response) => {
        if (stall === 'body') {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.flushHeaders();
          response.write('{"tunnels":');
        }
      });
      const healthy = http.createServer((_request, response) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            tunnels: [
              {
                config: { addr: 'http://localhost:13000' },
                public_url: 'https://static-roomote.ngrok.app',
              },
            ],
          }),
        );
      });
      const listen = async (server: http.Server) => {
        await new Promise<void>((resolve) =>
          server.listen(0, '127.0.0.1', resolve),
        );
        return (server.address() as AddressInfo).port;
      };
      const realFetch = globalThis.fetch;
      let resolution:
        | ReturnType<typeof NgrokService.resolvePublicUrl>
        | undefined;
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      try {
        const slowPort = await listen(slow);
        const healthyPort = await listen(healthy);
        const fetch = vi.fn((input: string, init?: RequestInit) => {
          // Route the normal inspect-port scan to isolated ephemeral peers,
          // retaining real fetch headers/body behavior and the supplied signal.
          const port = new URL(input).port === '4040' ? slowPort : healthyPort;
          return realFetch(`http://127.0.0.1:${port}/api/tunnels`, init);
        });
        vi.stubGlobal('fetch', fetch);
        resolution = NgrokService.resolvePublicUrl({
          port: 13000,
          verbose: false,
        });
        const boundedResolution = Promise.race([
          resolution,
          new Promise<never>((_resolve, reject) => {
            watchdog = setTimeout(
              () => reject(new Error('inspect scan stalled')),
              3_000,
            );
          }),
        ]);
        await expect(boundedResolution).resolves.toEqual({
          autoNgrok: true,
          publicUrl: 'https://static-roomote.ngrok.app',
        });
        expect(fetch.mock.calls.map(([url]) => new URL(url).port)).toEqual([
          '4040',
          '4041',
        ]);
        expect(execa).not.toHaveBeenCalledWith(
          'pm2',
          expect.anything(),
          expect.anything(),
        );
      } finally {
        clearTimeout(watchdog);
        slow.closeAllConnections();
        await resolution?.catch(() => undefined);
        healthy.closeAllConnections();
        await Promise.all(
          [slow, healthy].map(
            (server) =>
              new Promise<void>((resolve) => server.close(() => resolve())),
          ),
        );
      }
    },
    5_000,
  );
});
