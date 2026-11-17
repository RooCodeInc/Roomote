import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(
  new URL('../../../../../scripts/watchman.sh', import.meta.url),
);

describe('shared Watchman runtime lifecycle', () => {
  let root: string;
  let child: ChildProcess | undefined;
  let runtimePid: number | undefined;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'roomote-watchman-test-'));
    await mkdir(path.join(root, 'scripts'));
    await mkdir(path.join(root, 'apps/probe'), { recursive: true });
    await copyFile(script, path.join(root, 'scripts/watchman.sh'));
  });

  afterEach(async () => {
    child?.kill('SIGKILL');
    if (runtimePid) {
      try {
        process.kill(runtimePid, 'SIGKILL');
      } catch {
        /* already reaped */
      }
    }
    child = undefined;
    runtimePid = undefined;
    await rm(root, { recursive: true, force: true });
  });

  function run(runtime: string, build = 'true') {
    child = spawn(
      'bash',
      [
        '-c',
        `
      watchman() {
        printf '%s\\n' "$*" >> "$PROBE_ROOT/calls"
        if [[ "\${1:-}" == '-j' ]]; then command cat >/dev/null; fi
      }
      export -f watchman
      exec bash "$PROBE_ROOT/scripts/watchman.sh" probe "$1" "$2"
    `,
        'probe',
        build,
        runtime,
      ],
      {
        cwd: path.join(root, 'apps/probe'),
        env: { ...process.env, PROBE_ROOT: root },
        stdio: 'ignore',
      },
    );
    return once(child, 'exit');
  }

  async function cleanupCalls() {
    return (await readFile(path.join(root, 'calls'), 'utf8'))
      .split('\n')
      .filter((line) => line.startsWith('-- trigger-del '));
  }

  it.each([0, 7])(
    'removes the trigger and preserves runtime exit %s',
    async (code) => {
      const [status, signal] = await run(`exit ${code}`);
      expect([status, signal]).toEqual([code, null]);
      // First deletion clears an old trigger; the second releases the new one.
      expect(await cleanupCalls()).toHaveLength(2);
    },
  );

  it('cleans up without starting the runtime when initial compilation fails', async () => {
    const [status] = await run(`touch '${root}/unexpected-runtime'`, 'exit 9');
    expect(status).toBe(9);
    expect(await cleanupCalls()).toHaveLength(1);
    await expect(
      readFile(path.join(root, 'unexpected-runtime')),
    ).rejects.toThrow();
    expect(await readFile(path.join(root, 'calls'), 'utf8')).not.toContain(
      '-j',
    );
  });

  it.each([
    ['SIGTERM', 143],
    ['SIGINT', 130],
  ] as const)(
    'forwards %s shutdown, reaps the runtime and removes the trigger',
    async (signal, status) => {
      await writeFile(
        path.join(root, 'runtime.sh'),
        `echo $$ > '${root}/runtime.pid'\nexec sleep 300\n`,
      );
      const exited = run(`exec bash '${root}/runtime.sh'`);
      await vi.waitFor(async () => {
        runtimePid = Number(
          await readFile(path.join(root, 'runtime.pid'), 'utf8'),
        );
        expect(runtimePid).toBeGreaterThan(0);
      });
      child!.kill(signal);
      expect(await exited).toEqual([status, null]);
      expect(await cleanupCalls()).toHaveLength(2);
      expect(() => process.kill(runtimePid!, 0)).toThrow();
    },
  );
});
