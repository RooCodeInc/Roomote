import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { CommandExecutor } from '../command-executor';

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function isRunning(pid: number): Promise<boolean> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    return !stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

describe.skipIf(process.platform !== 'linux')(
  'foreground command deadlines',
  () => {
    let cwd: string;

    beforeEach(async () => {
      cwd = await mkdtemp(path.join(os.tmpdir(), 'command-deadline-'));
    });

    afterEach(async () => {
      for (const name of ['child.pid', 'grandchild.pid', 'sibling.pid']) {
        try {
          const pid = Number(await readFile(path.join(cwd, name), 'utf8'));
          if (await isRunning(pid)) process.kill(pid, 'SIGKILL');
        } catch (error) {
          if (
            !['ENOENT', 'ESRCH'].includes(
              (error as NodeJS.ErrnoException).code ?? '',
            )
          ) {
            throw error;
          }
        }
      }
      await rm(cwd, { recursive: true, force: true });
    });

    it.each([
      { shellWaits: true, ignoresTerm: false },
      { shellWaits: false, ignoresTerm: false },
      { shellWaits: true, ignoresTerm: true },
      { shellWaits: false, ignoresTerm: true },
    ])(
      'cleans descendants when $shellWaits/$ignoresTerm',
      async ({ shellWaits, ignoresTerm }) => {
        const grandchild = `${ignoresTerm ? 'process.on("SIGTERM", () => {});' : ''}require('node:fs').writeFileSync('grandchild.pid', String(process.pid)); setInterval(() => {}, 1000);`;
        const child = `${ignoresTerm ? 'process.on("SIGTERM", () => {});' : ''}require('node:fs').writeFileSync('child.pid', String(process.pid)); require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], {stdio:'inherit'}); setInterval(() => {}, 1000);`;
        const executor = new CommandExecutor(cwd, {});
        const result = await executor.execute({
          name: 'native process deadline',
          run: `${shellQuote(process.execPath)} -e ${shellQuote(child)} & ${shellWaits ? 'wait' : 'echo shell-exited'}`,
          timeout: 2,
          continue_on_error: true,
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain('timed out after 2000 milliseconds');
        expect(result.duration).toBeLessThan(12_000);
        for (const file of ['child.pid', 'grandchild.pid']) {
          const pid = Number(await readFile(path.join(cwd, file), 'utf8'));
          expect(await isRunning(pid), file).toBe(false);
        }
        if (!shellWaits) expect(result.stdout).toContain('shell-exited');

        // The next real command must run after cleanup, with no previous attempt
        // still able to mutate its workspace.
        const recovery = await executor.execute({
          name: 'command after timeout',
          run: 'echo recovered > recovery.txt; cat recovery.txt',
          timeout: 2,
          continue_on_error: false,
        });
        expect(recovery.success).toBe(true);
        expect(recovery.stdout).toBe('recovered');
        expect(await readFile(path.join(cwd, 'recovery.txt'), 'utf8')).toBe(
          'recovered\n',
        );
      },
      15_000,
    );

    it('preserves an unrelated concurrent command and normal output', async () => {
      const executor = new CommandExecutor(cwd, {});
      const sibling = executor.execute({
        name: 'independent command',
        run: 'echo $$ > sibling.pid; sleep 3; echo sibling-finished',
        timeout: 8,
        continue_on_error: false,
      });
      const result = await executor.execute({
        name: 'timed out command',
        run: 'sleep 30 & wait',
        timeout: 1,
        continue_on_error: true,
      });
      expect(result.success).toBe(false);
      expect((await sibling).stdout).toBe('sibling-finished');
    }, 12_000);

    it('retries only after the previous attempt has stopped', async () => {
      const retry = `const fs = require('node:fs'); if (fs.existsSync('child.pid')) { const pid = Number(fs.readFileSync('child.pid', 'utf8')); let running = false; try { const stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8'); running = !stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z'); } catch (error) { if (error.code !== 'ENOENT') throw error; } if (running) throw new Error('previous attempt still running'); fs.writeFileSync('retry.txt', 'recovered'); console.log('retry recovered'); } else { const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'inherit'}); fs.writeFileSync('child.pid', String(child.pid)); setInterval(() => {}, 1000); }`;
      const result = await new CommandExecutor(cwd, {}).execute({
        name: 'native retry after timeout',
        run: `${shellQuote(process.execPath)} -e ${shellQuote(retry)}`,
        timeout: 2,
        retries: 1,
        continue_on_error: false,
      });
      expect(result.success).toBe(true);
      expect(result.stdout).toBe('retry recovered');
      expect(await readFile(path.join(cwd, 'retry.txt'), 'utf8')).toBe(
        'recovered',
      );
    }, 12_000);
  },
);
