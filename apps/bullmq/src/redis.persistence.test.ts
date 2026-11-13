import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Queue, QueueEvents, Worker } from 'bullmq';
import Redis from 'ioredis';

const config = vi.hoisted(() => ({ redisUrl: '' }));
vi.mock('@roomote/env', () => ({
  Env: {
    get REDIS_URL() {
      return config.redisUrl;
    },
  },
}));

describe('BullMQ Redis URL database (real Redis)', () => {
  let directory: string;
  let redisProcess: ChildProcess;
  let baseUrl: string;

  beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'roomote-bullmq-redis-'));
    const reservation = createServer();
    reservation.listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const address = reservation.address();
    if (!address || typeof address === 'string')
      throw new Error('Missing Redis test port');
    const port = address.port;
    await new Promise<void>((resolve, reject) =>
      reservation.close((error) => (error ? reject(error) : resolve())),
    );
    baseUrl = `redis://127.0.0.1:${port}`;
    redisProcess = spawn(
      'redis-server',
      [
        '--bind',
        '127.0.0.1',
        '--port',
        String(port),
        '--save',
        '',
        '--appendonly',
        'no',
        '--dir',
        directory,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    await new Promise<void>((resolve, reject) => {
      let output = '';
      const timer = setTimeout(
        () => reject(new Error('Redis test server startup timed out')),
        10_000,
      );
      redisProcess.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      redisProcess.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`Redis test server exited: ${code}`));
      });
      redisProcess.stdout?.on('data', (chunk) => {
        output += chunk.toString();
        if (output.includes('Ready to accept connections')) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
  }, 15_000);

  afterAll(async () => {
    if (
      redisProcess?.pid &&
      redisProcess.exitCode === null &&
      redisProcess.signalCode === null
    ) {
      const exited = once(redisProcess, 'exit');
      redisProcess.kill('SIGTERM');
      await exited;
    }
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it.each([
    { pathname: '/12', database: 12 },
    { pathname: '', database: 0 },
    { pathname: '/0', database: 0 },
  ])(
    'consumes SDK-produced jobs in database $database for URL path "$pathname"',
    async ({ pathname, database }) => {
      vi.resetModules();
      config.redisUrl = `${baseUrl}${pathname}`;
      const { getRedis: getProducerRedis } = await import('@roomote/redis');
      const { getRedis: getWorkerRedis, closeRedis } = await import('./redis');
      const producer = getProducerRedis();
      const consumer = getWorkerRedis();
      const observer = new Redis(baseUrl);
      const name = `database-${randomUUID()}`;
      const marker = `${name}:processed`;
      const queue = new Queue(name, { connection: producer });
      const events = new QueueEvents(name, { connection: producer });
      const worker = new Worker(
        name,
        async (job) => {
          await consumer.set(marker, String(job.id));
          return job.data;
        },
        { connection: consumer },
      );
      try {
        await Promise.all([events.waitUntilReady(), worker.waitUntilReady()]);
        const job = await queue.add('probe', {
          value: 'same-url-same-database',
        });
        await expect(job.waitUntilFinished(events, 10_000)).resolves.toEqual({
          value: 'same-url-same-database',
        });
        expect(await job.getState()).toBe('completed');
        expect(await producer.get(marker)).toBe(job.id);
        expect(await consumer.get(marker)).toBe(job.id);
        expect(await consumer.call('CLIENT', 'INFO')).toContain(
          ` db=${database} `,
        );
        if (database !== 0) {
          expect(await observer.keys(`bull:${name}:*`)).toEqual([]);
          expect(await observer.get(marker)).toBeNull();
        }
      } finally {
        await worker.close();
        await events.close();
        await queue.obliterate({ force: true });
        await queue.close();
        await producer.del(marker);
        await producer.quit();
        await observer.quit();
        await closeRedis();
      }
    },
    15_000,
  );
});
