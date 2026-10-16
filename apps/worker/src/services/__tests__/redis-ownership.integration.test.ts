import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execa } from 'execa';

import { CommandExecutor } from '../../command-executor';
import { SERVICE_CONFIG } from '../constants';
import { createRedisService } from '../redis';

// Opt-in only: run in a disposable Linux worker with Redis and passwordless
// sudo. This exercises the actual service commands, including distro shutdown.
describe.each(['6', '7'])('Redis %s native ownership', (version) => {
  it('preserves an unrelated server and reuses its own server without losing work', async () => {
    const root = await mkdtemp(join(tmpdir(), 'roomote-redis-ownership-'));
    const foreignDir = join(root, 'foreign');
    const managedDir = join(root, 'managed');
    const config =
      version === '7' ? SERVICE_CONFIG.redis7 : SERVICE_CONFIG.redis6;
    const originalDataDir = config.dataDir;
    const listener = createServer();
    await new Promise<void>((resolve) =>
      listener.listen(0, '127.0.0.1', resolve),
    );
    const address = listener.address();
    if (!address || typeof address === 'string') throw new Error('No TCP port');
    const port = address.port;
    await new Promise<void>((resolve, reject) =>
      listener.close((error) => (error ? reject(error) : resolve())),
    );
    const cli = async (...args: string[]) =>
      (
        await execa('redis-cli', ['--raw', '-p', String(port), ...args], {
          timeout: 5000,
        })
      ).stdout.trim();
    const executor = new CommandExecutor(root, {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
    });

    try {
      await mkdir(foreignDir);
      Object.assign(config, { dataDir: managedDir });
      await execa('redis-server', [
        '--daemonize',
        'yes',
        '--port',
        String(port),
        '--dir',
        foreignDir,
        '--pidfile',
        join(foreignDir, 'redis.pid'),
        '--save',
        '',
      ]);
      await cli('SET', 'proof:work', 'unsaved-foreign-work');
      const foreignInfo = await cli('INFO', 'server');
      const service = createRedisService(version);
      let startError: unknown;
      try {
        await service.start(executor, port);
      } catch (error) {
        startError = error;
      }
      const foreignWork = await cli('GET', 'proof:work');
      const afterInfo = await cli('INFO', 'server');
      console.log({
        version,
        port,
        rejected: Boolean(startError),
        foreignWork,
        sameProcess:
          foreignInfo.match(/process_id:\d+/)?.[0] ===
          afterInfo.match(/process_id:\d+/)?.[0],
      });
      expect(startError).toBeInstanceOf(Error);
      expect(foreignWork).toBe('unsaved-foreign-work');
      expect(afterInfo.match(/process_id:\d+/)?.[0]).toBe(
        foreignInfo.match(/process_id:\d+/)?.[0],
      );
      expect(await service.verifyManagedInstance?.(port)).toBe(false);

      // Remove the actual conflict, then retry the same startup path.
      await cli('SHUTDOWN', 'NOSAVE');
      await service.start(executor, port);
      expect(await service.verifyManagedInstance?.(port)).toBe(true);
      await cli('SET', 'proof:work', 'unsaved-managed-work');
      const managedInfo = await cli('INFO', 'server');
      await service.start(executor, port);
      expect(await cli('GET', 'proof:work')).toBe('unsaved-managed-work');
      expect((await cli('INFO', 'server')).match(/process_id:\d+/)?.[0]).toBe(
        managedInfo.match(/process_id:\d+/)?.[0],
      );
      // Disk persistence and a real stopped-server restart remain supported.
      await cli('SAVE');
      await cli('SHUTDOWN', 'NOSAVE');
      await service.start(executor, port);
      expect(await cli('GET', 'proof:work')).toBe('unsaved-managed-work');
      expect(await service.verifyManagedInstance?.(port)).toBe(true);
    } finally {
      await cli('SHUTDOWN', 'NOSAVE').catch(() => {});
      Object.assign(config, { dataDir: originalDataDir });
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});
