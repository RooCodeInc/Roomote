import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';

import { CommandExecutor, resolvePm2Invocation } from '../command-executor';

// Opt-in: requires the real PM2 CLI installed by the worker/runtime environment.
it('bounds stalled real PM2 daemon IPC and recovers after the daemon resumes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'roomote-pm2-proof-'));
  const env = {
    PATH: process.env.PATH,
    HOME: root,
    PM2_HOME: join(root, 'pm2'),
  };
  let invocation: Awaited<ReturnType<typeof resolvePm2Invocation>> | undefined;
  const pm2 = (args: string[]) =>
    execa(invocation!.command, [...invocation!.argsPrefix, ...args], {
      cwd: root,
      env,
      extendEnv: false,
      timeout: 10_000,
    });
  let daemonPid: number | undefined;
  let pending: Promise<unknown> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    invocation = await resolvePm2Invocation({ cwd: root, env });
    await pm2(['ping']);
    daemonPid = Number(await readFile(join(env.PM2_HOME, 'pm2.pid'), 'utf8'));
    if (!Number.isSafeInteger(daemonPid) || daemonPid <= 1)
      throw new Error('No owned PM2 daemon PID');
    process.kill(daemonPid, 'SIGSTOP');
    const executor = new CommandExecutor(root, env, false, {
      detachedProcessManager: 'pm2',
    });
    const start = Date.now();
    pending = executor.executeAll([]).then(
      () => ({ settled: true, error: '' }),
      (error: Error) => ({ settled: true, error: error.message }),
    );
    const observed = (await Promise.race([
      pending,
      new Promise<{ settled: false }>(
        (resolve) =>
          (deadline = setTimeout(() => resolve({ settled: false }), 33_000)),
      ),
    ])) as { settled: boolean; error?: string };
    clearTimeout(deadline);
    console.log(
      JSON.stringify({
        phase: 'paused-daemon',
        durationMs: Date.now() - start,
        ...observed,
      }),
    );
    process.kill(daemonPid, 'SIGCONT');
    await pending;
    expect(observed.settled).toBe(true);
    expect(observed.error).toContain('timed out');
    expect(
      await executor.executeAll([
        {
          name: 'Healthy control',
          run: 'printf recovered',
          timeout: 5,
          continue_on_error: false,
        },
      ]),
    ).toEqual([
      expect.objectContaining({ success: true, stdout: 'recovered' }),
    ]);
    console.log(JSON.stringify({ phase: 'resumed-daemon', recovered: true }));
  } finally {
    clearTimeout(deadline);
    if (daemonPid) {
      try {
        process.kill(daemonPid, 'SIGCONT');
      } catch {
        // The owned daemon may already have exited.
      }
    }
    await pending;
    if (invocation) await pm2(['kill']).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}, 55_000);
