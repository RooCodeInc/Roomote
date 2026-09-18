import { execFile, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

const installerPath = fileURLToPath(
  new URL(
    '../../../../../../.docker/sandbox/install-browser-agent.sh',
    import.meta.url,
  ),
);

function readWrapper(): string {
  const installer = fs.readFileSync(installerPath, 'utf8');
  const match = installer.match(/cat <<'EOF_WRAPPER'\n([\s\S]*?)\nEOF_WRAPPER/);
  if (!match?.[1]) {
    throw new Error('Could not extract agent-browser wrapper');
  }
  return match[1];
}

describe('agent-browser wrapper', () => {
  it.each([
    ['--help'],
    ['--version'],
    ['record', 'start', '/tmp/help-start.webm', '--help'],
    ['record', 'restart', '/tmp/help-restart.webm', '--help'],
  ])(
    'forwards informational invocation without preview setup: %s',
    (...args) => {
      const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'agent-browser-wrapper-'),
      );
      const cliPath = path.join(tempDir, 'agent-browser-real');
      const wrapperPath = path.join(tempDir, 'agent-browser');
      const callsPath = path.join(tempDir, 'calls');
      const savedCliPath = path.join(tempDir, '.cli-path');

      fs.writeFileSync(
        cliPath,
        '#!/bin/sh\nprintf "%s\\n" "$*" >> "$AGENT_BROWSER_TEST_CALLS"\n',
        { mode: 0o755 },
      );
      fs.writeFileSync(savedCliPath, cliPath);
      fs.writeFileSync(
        wrapperPath,
        readWrapper()
          .replace('/opt/agent-browser/.cli-path', savedCliPath)
          .replace(
            '/tmp/agent-browser-cookie-seed',
            path.join(tempDir, 'cache'),
          ),
        { mode: 0o755 },
      );

      try {
        execFileSync(wrapperPath, args, {
          env: {
            ...process.env,
            AGENT_BROWSER_TEST_CALLS: callsPath,
            ROOMOTE_WEB_PREVIEW_URL: 'https://preview.example.com',
          },
        });

        expect(fs.readFileSync(callsPath, 'utf8').trim().split('\n')).toEqual([
          args.join(' '),
        ]);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );
});

describe('agent-browser wrapper shared browser', () => {
  const cleanups: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  function listen(server: net.Server, target: number | string): Promise<void> {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      if (typeof target === 'string') {
        server.listen(target, resolve);
      } else {
        server.listen(target, '127.0.0.1', resolve);
      }
    });
  }

  function close(server: net.Server): Promise<void> {
    return new Promise((resolve) => server.close(() => resolve()));
  }

  async function reservePort(): Promise<number> {
    const server = net.createServer();
    await listen(server, 0);
    const { port } = server.address() as net.AddressInfo;
    await close(server);
    return port;
  }

  /**
   * A sandbox with the Shared Desktop running: an X socket for the display
   * and a desktop service answering /config and /metrics.
   */
  async function createSandbox(
    options: {
      metrics?: Record<string, unknown>;
      browserRunning?: boolean;
      fakeChrome?: 'opens-port' | 'exits';
    } = {},
  ) {
    // Unix socket paths are length-limited, so keep the directory short.
    const dir = fs.mkdtempSync('/tmp/abw-');
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));

    const cliPath = path.join(dir, 'agent-browser-real');
    const wrapperPath = path.join(dir, 'agent-browser');
    const callsPath = path.join(dir, 'calls');
    const savedCliPath = path.join(dir, '.cli-path');
    const chromePath = path.join(dir, 'chrome');
    const chromeArgsPath = path.join(dir, 'chrome-args');
    const chromePidPath = path.join(dir, 'chrome-pid');
    const x11Dir = path.join(dir, 'x11');
    fs.mkdirSync(x11Dir);

    fs.writeFileSync(
      cliPath,
      [
        '#!/bin/sh',
        'printf "pin=%s %s\\n" "${AGENT_BROWSER_PIN_TAB:-}" "$*" >> "$AGENT_BROWSER_TEST_CALLS"',
        'if [ -n "${FAKE_TAB_GONE_ONCE:-}" ] && [ ! -f "$FAKE_TAB_GONE_ONCE" ]; then',
        '  : > "$FAKE_TAB_GONE_ONCE"',
        '  echo "tab_gone: bound tab is gone" >&2',
        '  exit 1',
        'fi',
        'echo ok',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    fs.writeFileSync(savedCliPath, cliPath);
    fs.writeFileSync(
      wrapperPath,
      readWrapper()
        .replace('/opt/agent-browser/.cli-path', savedCliPath)
        .replace('/tmp/agent-browser-cookie-seed', path.join(dir, 'cache')),
      { mode: 0o755 },
    );

    const cdpPort = await reservePort();
    fs.writeFileSync(
      chromePath,
      options.fakeChrome === 'exits'
        ? '#!/bin/sh\nexit 1\n'
        : [
            '#!/bin/sh',
            'printf "%s\\n" "$@" > "$FAKE_CHROME_ARGS"',
            'echo $$ > "$FAKE_CHROME_PID"',
            `exec "${process.execPath}" -e "require('net').createServer().listen(${cdpPort}, '127.0.0.1')"`,
            '',
          ].join('\n'),
      { mode: 0o755 },
    );
    cleanups.push(() => {
      try {
        process.kill(Number(fs.readFileSync(chromePidPath, 'utf8')));
      } catch {
        // The fake browser was never started.
      }
    });

    const x11Socket = net.createServer();
    await listen(x11Socket, path.join(x11Dir, 'X99'));
    cleanups.push(() => close(x11Socket));

    const desktop = http.createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify(
          request.url === '/config'
            ? { capture_mode: 'x11', width: 1440, height: 900 }
            : (options.metrics ?? { control_connected: false }),
        ),
      );
    });
    await listen(desktop, 0);
    cleanups.push(() => close(desktop));

    if (options.browserRunning) {
      const browser = net.createServer();
      await listen(browser, cdpPort);
      cleanups.push(() => close(browser));
    }

    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: dir,
      DISPLAY: ':99',
      ROOMOTE_DESKTOP_STREAM_PORT: String(
        (desktop.address() as net.AddressInfo).port,
      ),
      ROOMOTE_SHARED_BROWSER_CDP_PORT: String(cdpPort),
      ROOMOTE_SHARED_BROWSER_X11_SOCKET_DIR: x11Dir,
      ROOMOTE_SHARED_BROWSER_STATE_DIR: path.join(dir, 'state'),
      ROOMOTE_SHARED_BROWSER_LAUNCH_WAIT_SECONDS: '5',
      ROOMOTE_SHARED_BROWSER_HUMAN_WAIT_SECONDS: '0',
      AGENT_BROWSER_EXECUTABLE_PATH: chromePath,
      AGENT_BROWSER_TEST_CALLS: callsPath,
      FAKE_CHROME_ARGS: chromeArgsPath,
      FAKE_CHROME_PID: chromePidPath,
    };

    return {
      dir,
      cdpPort,
      chromeArgsPath,
      run: (args: string[], extraEnv: NodeJS.ProcessEnv = {}) =>
        execFileAsync(wrapperPath, args, { env: { ...env, ...extraEnv } }),
      calls: () =>
        fs.existsSync(callsPath)
          ? fs.readFileSync(callsPath, 'utf8').trim().split('\n')
          : [],
    };
  }

  it('attaches to the running shared browser and pins the session tab', async () => {
    const sandbox = await createSandbox({ browserRunning: true });

    await sandbox.run(['snapshot', '-i']);

    expect(sandbox.calls()).toEqual([
      `pin=1 --cdp ${sandbox.cdpPort} snapshot -i`,
    ]);
    expect(fs.existsSync(sandbox.chromeArgsPath)).toBe(false);
  });

  it('starts the shared browser on the desktop on first use', async () => {
    const sandbox = await createSandbox();

    await sandbox.run(['click', '@e1']);

    const chromeArgs = fs
      .readFileSync(sandbox.chromeArgsPath, 'utf8')
      .trim()
      .split('\n');
    expect(chromeArgs).toContain(`--remote-debugging-port=${sandbox.cdpPort}`);
    expect(chromeArgs).toContain('--window-size=1440,900');
    expect(chromeArgs.some((arg) => arg.startsWith('--user-data-dir='))).toBe(
      true,
    );
    expect(chromeArgs).not.toContain('--headless');
    expect(chromeArgs.at(-1)).toBe('about:blank');
    expect(sandbox.calls()).toEqual([
      `pin=1 --cdp ${sandbox.cdpPort} click @e1`,
    ]);
  });

  it('opens a fresh tab before a navigation when the pinned tab is gone', async () => {
    const sandbox = await createSandbox({ browserRunning: true });

    await sandbox.run(['--session', 'task-1', 'goto', 'https://example.com'], {
      FAKE_TAB_GONE_ONCE: path.join(sandbox.dir, 'tab-gone'),
    });
    await sandbox.run(['--session', 'task-1', 'goto', 'https://example.org']);

    expect(sandbox.calls()).toEqual([
      `pin=1 --cdp ${sandbox.cdpPort} --session task-1 get url`,
      `pin=1 --cdp ${sandbox.cdpPort} --session task-1 tab new`,
      `pin=1 --cdp ${sandbox.cdpPort} --session task-1 goto https://example.com`,
      `pin=1 --cdp ${sandbox.cdpPort} --session task-1 get url`,
      `pin=1 --cdp ${sandbox.cdpPort} --session task-1 goto https://example.org`,
    ]);
  });

  it.each([
    [['record', 'start', '/tmp/demo.webm', 'https://example.com'], true],
    [['record', 'start', '/tmp/demo.webm'], false],
    [['record', 'restart', '/tmp/demo.webm'], false],
  ])(
    'only replaces a gone tab for a recording that loads its own page: %j',
    async (args, probesTab) => {
      const sandbox = await createSandbox({ browserRunning: true });

      await sandbox.run(args);

      expect(sandbox.calls()).toEqual([
        ...(probesTab ? [`pin=1 --cdp ${sandbox.cdpPort} get url`] : []),
        `pin=1 --cdp ${sandbox.cdpPort} ${args.join(' ')}`,
      ]);
    },
  );

  it('reports a gone tab to commands that depended on its page', async () => {
    const sandbox = await createSandbox({ browserRunning: true });

    await expect(
      sandbox.run(['click', '@e1'], {
        FAKE_TAB_GONE_ONCE: path.join(sandbox.dir, 'tab-gone'),
      }),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('tab_gone'),
    });
    expect(sandbox.calls()).toEqual([
      `pin=1 --cdp ${sandbox.cdpPort} click @e1`,
    ]);
  });

  it('falls back to a private headless browser when the shared one fails to start', async () => {
    const sandbox = await createSandbox({ fakeChrome: 'exits' });

    const { stderr } = await sandbox.run(['click', '@e1'], {
      ROOMOTE_SHARED_BROWSER_LAUNCH_WAIT_SECONDS: '1',
    });

    expect(stderr).toContain('using a private headless browser');
    expect(sandbox.calls()).toEqual(['pin= click @e1']);
  });

  it.each([
    [['snapshot'], { ROOMOTE_SHARED_BROWSER: '0' }],
    [['--cdp', '9333', 'snapshot'], {}],
    [['--profile', 'Default', 'snapshot'], {}],
    [['skills', 'get', 'core'], {}],
    [['snapshot', '--help'], {}],
  ])(
    'leaves the invocation alone when it does not use the shared browser: %j',
    async (args, extraEnv) => {
      const sandbox = await createSandbox();

      await sandbox.run(args, extraEnv);

      expect(sandbox.calls()).toEqual([`pin= ${args.join(' ')}`]);
      expect(fs.existsSync(sandbox.chromeArgsPath)).toBe(false);
    },
  );

  it('keeps launching a private browser without the Shared Desktop', async () => {
    const sandbox = await createSandbox({ browserRunning: true });

    await sandbox.run(['snapshot'], { ROOMOTE_DESKTOP_STREAM_PORT: '' });
    await sandbox.run(['snapshot'], { DISPLAY: ':42' });

    expect(sandbox.calls()).toEqual(['pin= snapshot', 'pin= snapshot']);
  });

  it('yields input commands to a person driving the desktop', async () => {
    const sandbox = await createSandbox({
      browserRunning: true,
      metrics: { control_connected: true, control_idle_ms: 500 },
    });

    await expect(sandbox.run(['click', '@e1'])).rejects.toMatchObject({
      code: 75,
      stderr: expect.stringContaining('a person is using the shared browser'),
    });
    expect(sandbox.calls()).toEqual([]);

    await sandbox.run(['screenshot', '/tmp/shot.png']);
    await sandbox.run(['tab', 'list']);
    expect(sandbox.calls()).toEqual([
      `pin=1 --cdp ${sandbox.cdpPort} screenshot /tmp/shot.png`,
      `pin=1 --cdp ${sandbox.cdpPort} tab list`,
    ]);
  });

  it.each([
    [['cookies', 'set', 'sid', 'x', '--url', 'https://example.com']],
    [['cookies', 'clear']],
    [['storage', 'local', 'set', 'token', 'x']],
    [['storage', 'session', 'clear']],
    [['network', 'route', 'https://example.com/*', '--abort']],
    [['state', 'load', '/tmp/state.json']],
    [['tab', 'new']],
  ])(
    'holds commands that change the shared session while a person drives: %j',
    async (args) => {
      const sandbox = await createSandbox({
        browserRunning: true,
        metrics: { control_connected: true, control_idle_ms: 500 },
      });

      await expect(sandbox.run(args)).rejects.toMatchObject({ code: 75 });
      expect(sandbox.calls()).toEqual([]);
    },
  );

  it.each([
    [['cookies']],
    [['cookies', 'get']],
    [['storage', 'local']],
    [['storage', 'local', 'get', 'token']],
    [['network', 'requests']],
    [['state', 'save', '/tmp/state.json']],
  ])(
    'lets commands that only read the shared session through: %j',
    async (args) => {
      const sandbox = await createSandbox({
        browserRunning: true,
        metrics: { control_connected: true, control_idle_ms: 500 },
      });

      await sandbox.run(args);

      expect(sandbox.calls()).toEqual([
        `pin=1 --cdp ${sandbox.cdpPort} ${args.join(' ')}`,
      ]);
    },
  );

  it.each([
    [{ control_connected: true, control_idle_ms: 60_000 }],
    [{ control_connected: true }],
    [{ control_connected: false, control_idle_ms: 500 }],
  ])('runs input commands when nobody is driving: %j', async (metrics) => {
    const sandbox = await createSandbox({ browserRunning: true, metrics });

    await sandbox.run(['click', '@e1']);

    expect(sandbox.calls()).toEqual([
      `pin=1 --cdp ${sandbox.cdpPort} click @e1`,
    ]);
  });
});
