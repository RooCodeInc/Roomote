import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const nativeInotify = spawnSync('which', ['inotifywait'], { encoding: 'utf8' });
const hasInotify = process.platform === 'linux' && nativeInotify.status === 0;
const scriptSource = fileURLToPath(
  new URL('../../../../../scripts/watchman.sh', import.meta.url),
);
const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// Native coverage requires inotify-tools. The fixture retains the real shell,
// monitor, event stream, child processes and disk; only compilation is a small
// disposable command so that its read/publish ordering is deterministic.
describe.skipIf(!hasInotify)('shared dev watcher with native inotify', () => {
  let root: string;
  let app: string;
  let child: ChildProcess | undefined;
  let exited: Promise<number | null> | undefined;
  let output: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'dev-watch-native-'));
    app = path.join(root, 'apps/proof');
    await Promise.all(
      ['scripts', 'packages', 'bin', 'tmp', 'apps/proof/src'].map((dir) =>
        fs.mkdir(path.join(root, dir), { recursive: true }),
      ),
    );
    await fs.copyFile(scriptSource, path.join(root, 'scripts/watchman.sh'));
    // Force the supported fallback even on hosts with Watchman installed.
    await fs.writeFile(path.join(root, 'bin/watchman'), '#!/bin/sh\nexit 1\n', {
      mode: 0o755,
    });
    await fs.writeFile(
      path.join(root, 'bin/inotifywait'),
      `#!/bin/sh\necho $$ > '${app}/monitor-pid'\nexec '${nativeInotify.stdout.trim()}' "$@"\n`,
      { mode: 0o755 },
    );
    await fs.writeFile(path.join(app, 'src/revision.ts'), 'first');
    await fs.writeFile(
      path.join(app, 'build.mjs'),
      `
import fs from 'node:fs/promises';
const text = await fs.readFile('src/revision.ts', 'utf8');
await fs.appendFile('builds', text + '\\n');
if (text === 'fail') process.exit(17);
if (text === 'second') {
  await fs.writeFile('second-started', '');
  while (true) {
    try { await fs.access('release-second'); break; }
    catch { await new Promise(resolve => setTimeout(resolve, 20)); }
  }
}
await fs.writeFile('published', text);
`,
    );
    await fs.writeFile(
      path.join(app, 'run.mjs'),
      `
import fs from 'node:fs';
fs.appendFileSync('runtime-pids', process.pid + '\\n');
setInterval(() => {}, 1000);
`,
    );
    output = '';
    child = undefined;
    exited = undefined;
  });

  const start = () => {
    child = spawn(
      'bash',
      [
        path.join(root, 'scripts/watchman.sh'),
        'proof',
        `${process.execPath} build.mjs`,
        `${process.execPath} run.mjs`,
      ],
      {
        cwd: app,
        detached: true,
        env: {
          ...process.env,
          PATH: `${root}/bin:${process.env.PATH}`,
          TMPDIR: path.join(root, 'tmp'),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    child.stdout!.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr!.on('data', (chunk) => {
      output += chunk;
    });
    exited = new Promise((resolve) => child!.once('exit', resolve));
  };
  const ready = async () => {
    await vi.waitFor(() => expect(output).toContain('Watching for changes'), {
      timeout: 5_000,
    });
    await vi.waitFor(
      async () =>
        expect(
          await fs.readFile(path.join(app, 'runtime-pids'), 'utf8'),
        ).not.toBe(''),
      { timeout: 5_000 },
    );
  };
  const expectCleaned = async () => {
    const monitor = Number(
      await fs.readFile(path.join(app, 'monitor-pid'), 'utf8'),
    );
    const runtimes = await fs
      .readFile(path.join(app, 'runtime-pids'), 'utf8')
      .catch(() => '');
    await vi.waitFor(() => {
      expect(isAlive(monitor)).toBe(false);
      for (const pid of runtimes.trim().split(/\s+/).filter(Boolean))
        expect(isAlive(Number(pid))).toBe(false);
    });
    expect(await fs.readdir(path.join(root, 'tmp'))).toEqual([]);
  };

  afterEach(async () => {
    await fs.writeFile(path.join(app, 'release-second'), '');
    if (child?.pid) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* already exited */
      }
      await exited;
    }
    await fs.rm(root, { recursive: true, force: true });
  });

  it.each(['initial', 'later'])(
    'retains edits during the %s compilation and reaps owned children on idle TERM',
    async (build) => {
      if (build === 'initial')
        await fs.writeFile(path.join(app, 'src/revision.ts'), 'second');
      start();
      if (build === 'later') {
        await ready();
        await fs.writeFile(path.join(app, 'src/revision.ts'), 'second');
      }
      await vi.waitFor(() => fs.access(path.join(app, 'second-started')), {
        timeout: 5_000,
      });
      await fs.writeFile(path.join(app, 'src/revision.ts'), 'third');
      await fs.writeFile(path.join(app, 'release-second'), '');
      await vi.waitFor(
        async () =>
          expect(await fs.readFile(path.join(app, 'published'), 'utf8')).toBe(
            'third',
          ),
        { timeout: 5_000 },
      );
      child!.kill('SIGTERM');
      await vi.waitFor(() => expect(child!.exitCode).toBe(143), {
        timeout: 5_000,
      });
      await expectCleaned();
    },
    15_000,
  );

  it('continues watching and recovers after a later compiler failure', async () => {
    start();
    await ready();
    await fs.writeFile(path.join(app, 'src/revision.ts'), 'fail');
    await vi.waitFor(
      async () =>
        expect(await fs.readFile(path.join(app, 'builds'), 'utf8')).toContain(
          'fail\n',
        ),
      { timeout: 5_000 },
    );
    await fs.writeFile(path.join(app, 'src/revision.ts'), 'third');
    await vi.waitFor(
      async () =>
        expect(await fs.readFile(path.join(app, 'published'), 'utf8')).toBe(
          'third',
        ),
      { timeout: 5_000 },
    );
    child!.kill('SIGTERM');
    await vi.waitFor(() => expect(child!.exitCode).toBe(143), {
      timeout: 5_000,
    });
    await expectCleaned();
  }, 15_000);

  it('cleans the monitor and temporary pipe when the initial build fails', async () => {
    await fs.writeFile(path.join(app, 'src/revision.ts'), 'fail');
    start();
    await vi.waitFor(() => expect(child!.exitCode).toBe(17), {
      timeout: 5_000,
    });
    await expectCleaned();
    await expect(fs.access(path.join(app, 'runtime-pids'))).rejects.toThrow();
  }, 10_000);

  it('fails and cleans the runtime when the event monitor exits', async () => {
    start();
    await ready();
    const monitor = Number(
      await fs.readFile(path.join(app, 'monitor-pid'), 'utf8'),
    );
    process.kill(monitor, 'SIGTERM');
    await vi.waitFor(() => expect(child!.exitCode).toBe(1), { timeout: 5_000 });
    await expectCleaned();
  }, 10_000);
});
