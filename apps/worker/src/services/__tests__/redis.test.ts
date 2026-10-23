import { execa } from 'execa';

import type { CommandExecutor } from '../../command-executor';

import { createRedisService } from '../redis';

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

describe('createRedisService', () => {
  const mockedExeca = vi.mocked(execa);

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it.each(['6', '7'])(
    'rejects an unrelated Redis %s target before changing its files or process',
    async (version) => {
      const execute = vi.fn().mockResolvedValue({ success: true });
      const executor = { execute } as unknown as CommandExecutor;
      mockedExeca.mockResolvedValue({ stdout: 'PONG' } as Awaited<
        ReturnType<typeof execa>
      >);
      const service = createRedisService(version);
      vi.spyOn(service, 'verifyManagedInstance').mockResolvedValue(false);

      await expect(service.start(executor, 6380)).rejects.toThrow(
        'port 6380 is occupied by an unrelated Redis instance',
      );
      expect(execute.mock.calls.map(([command]) => command.name)).toEqual([
        'Create Redis data directory',
        'Stop auto-started Redis',
      ]);
    },
  );

  it.each(['6', '7'])(
    'reuses an already managed Redis %s instance',
    async (version) => {
      const execute = vi.fn().mockResolvedValue({ success: true });
      const executor = { execute } as unknown as CommandExecutor;
      mockedExeca.mockResolvedValue({ stdout: 'PONG' } as Awaited<
        ReturnType<typeof execa>
      >);
      const service = createRedisService(version);
      vi.spyOn(service, 'verifyManagedInstance').mockResolvedValue(true);

      await expect(service.start(executor, 6380)).resolves.toBeUndefined();
      expect(execute.mock.calls.map(([command]) => command.name)).toEqual([
        'Create Redis data directory',
        'Stop auto-started Redis',
      ]);
    },
  );

  it('verifies the managed Redis instance from live server state', async () => {
    mockedExeca.mockImplementation((async (
      command: string | URL,
      args: unknown,
    ) => {
      if (
        command === 'redis-cli' &&
        JSON.stringify(args) === JSON.stringify(['-p', '6380', 'ping'])
      ) {
        return { stdout: 'PONG' } as Awaited<ReturnType<typeof execa>>;
      }

      if (
        command === 'redis-cli' &&
        JSON.stringify(args) ===
          JSON.stringify(['-p', '6380', 'INFO', 'server'])
      ) {
        return {
          stdout: 'redis_version:7.0.0\nprocess_id:123\n',
        } as Awaited<ReturnType<typeof execa>>;
      }

      if (
        command === 'redis-cli' &&
        JSON.stringify(args) ===
          JSON.stringify(['--raw', '-p', '6380', 'CONFIG', 'GET', 'dir'])
      ) {
        return {
          stdout: 'dir\n/data/services/redis\n',
        } as Awaited<ReturnType<typeof execa>>;
      }

      if (
        command === 'redis-cli' &&
        JSON.stringify(args) ===
          JSON.stringify(['--raw', '-p', '6380', 'CONFIG', 'GET', 'pidfile'])
      ) {
        return {
          stdout: 'pidfile\n/data/services/redis/valkey.pid\n',
        } as Awaited<ReturnType<typeof execa>>;
      }

      if (
        command === 'ps' &&
        JSON.stringify(args) ===
          JSON.stringify(['-p', '123', '-o', 'stat=', '-o', 'comm='])
      ) {
        return {
          stdout: 'Ss redis-server\n',
        } as Awaited<ReturnType<typeof execa>>;
      }

      throw new Error(
        `Unexpected execa call: ${command} ${JSON.stringify(args)}`,
      );
    }) as typeof execa);

    const service = createRedisService('7');

    await expect(service.verifyManagedInstance?.(6380)).resolves.toBe(true);
    expect(mockedExeca.mock.calls.some(([command]) => command === 'cat')).toBe(
      false,
    );
  });

  it('verifies the managed Redis 6 instance with Ubuntu redis binaries', async () => {
    mockedExeca.mockImplementation((async (
      command: string | URL,
      args: unknown,
    ) => {
      if (
        command === 'redis-cli' &&
        JSON.stringify(args) === JSON.stringify(['-p', '6380', 'ping'])
      ) {
        return { stdout: 'PONG' } as Awaited<ReturnType<typeof execa>>;
      }

      if (
        command === 'redis-cli' &&
        JSON.stringify(args) ===
          JSON.stringify(['-p', '6380', 'INFO', 'server'])
      ) {
        return {
          stdout: 'redis_version:6.2.0\nprocess_id:123\n',
        } as Awaited<ReturnType<typeof execa>>;
      }

      if (
        command === 'redis-cli' &&
        JSON.stringify(args) ===
          JSON.stringify(['--raw', '-p', '6380', 'CONFIG', 'GET', 'dir'])
      ) {
        return {
          stdout: 'dir\n/data/services/redis\n',
        } as Awaited<ReturnType<typeof execa>>;
      }

      if (
        command === 'redis-cli' &&
        JSON.stringify(args) ===
          JSON.stringify(['--raw', '-p', '6380', 'CONFIG', 'GET', 'pidfile'])
      ) {
        return {
          stdout: 'pidfile\n/data/services/redis/redis.pid\n',
        } as Awaited<ReturnType<typeof execa>>;
      }

      if (
        command === 'ps' &&
        JSON.stringify(args) ===
          JSON.stringify(['-p', '123', '-o', 'stat=', '-o', 'comm='])
      ) {
        return {
          stdout: 'Ss redis-server\n',
        } as Awaited<ReturnType<typeof execa>>;
      }

      throw new Error(
        `Unexpected execa call: ${command} ${JSON.stringify(args)}`,
      );
    }) as typeof execa);

    const service = createRedisService('6');

    await expect(service.verifyManagedInstance?.(6380)).resolves.toBe(true);
  });

  it('rejects a Redis instance running with a different managed directory', async () => {
    mockedExeca.mockImplementation((async (
      command: string | URL,
      args: unknown,
    ) => {
      if (
        command === 'redis-cli' &&
        JSON.stringify(args) === JSON.stringify(['-p', '6380', 'ping'])
      ) {
        return { stdout: 'PONG' } as Awaited<ReturnType<typeof execa>>;
      }

      if (
        command === 'redis-cli' &&
        JSON.stringify(args) ===
          JSON.stringify(['-p', '6380', 'INFO', 'server'])
      ) {
        return {
          stdout: 'redis_version:7.0.0\nprocess_id:123\n',
        } as Awaited<ReturnType<typeof execa>>;
      }

      if (
        command === 'redis-cli' &&
        JSON.stringify(args) ===
          JSON.stringify(['--raw', '-p', '6380', 'CONFIG', 'GET', 'dir'])
      ) {
        return {
          stdout: 'dir\n/tmp/foreign-redis\n',
        } as Awaited<ReturnType<typeof execa>>;
      }

      if (
        command === 'redis-cli' &&
        JSON.stringify(args) ===
          JSON.stringify(['--raw', '-p', '6380', 'CONFIG', 'GET', 'pidfile'])
      ) {
        return {
          stdout: 'pidfile\n/data/services/redis/valkey.pid\n',
        } as Awaited<ReturnType<typeof execa>>;
      }

      throw new Error(
        `Unexpected execa call: ${command} ${JSON.stringify(args)}`,
      );
    }) as typeof execa);

    const service = createRedisService('7');

    await expect(service.verifyManagedInstance?.(6380)).resolves.toBe(false);
  });
});
