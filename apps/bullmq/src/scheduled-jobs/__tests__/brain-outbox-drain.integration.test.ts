import { createServer, type Server } from 'node:http';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RunStatus, TaskPayloadKind } from '@roomote/types';

import {
  brainMemoryEvents,
  db,
  eq,
  maybeEnqueueBrainMemoryEvent,
  taskFactory,
  taskRuns,
  tasks,
  runFactory,
} from '@roomote/db/server';

let brainUrl = '';
const receivedBodies: string[] = [];

vi.mock('@roomote/sdk/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/sdk/server')>()),
  isBrainEmbeddingAvailable: vi.fn().mockResolvedValue(true),
  resolveBrainConnection: vi.fn(async () => ({
    baseUrl: brainUrl,
    token: 'local-test-token',
  })),
}));

import { drainOneBatch } from '../brain-outbox-drain';

let server: Server;
const createdTaskIds: string[] = [];
const createdRunIds: number[] = [];

beforeEach(async () => {
  receivedBodies.length = 0;
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      receivedBodies.push(Buffer.concat(chunks).toString('utf8'));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ result: {} }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('server did not bind');
  brainUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  for (const runId of createdRunIds) {
    await db
      .delete(brainMemoryEvents)
      .where(eq(brainMemoryEvents.runId, runId));
    await db.delete(taskRuns).where(eq(taskRuns.id, runId));
  }
  for (const taskId of createdTaskIds.splice(0)) {
    await db.delete(tasks).where(eq(tasks.id, taskId));
  }
  createdRunIds.splice(0);
});

describe('real task memory drain', () => {
  it('skips snapshot maintenance and publishes a normal task through the local Brain sink', async () => {
    const snapshotTask = await taskFactory.create({
      privacy: 'shared',
      title: 'Untitled task',
      actorExternalId: 'snapshot-maintenance-test',
    });
    const normalTask = await taskFactory.create({
      privacy: 'shared',
      title: 'Useful task',
      actorExternalId: 'normal-task-test',
    });
    createdTaskIds.push(snapshotTask.id, normalTask.id);

    const snapshotRun = await runFactory.create({
      taskId: snapshotTask.id,
      payloadKind: TaskPayloadKind.SnapshotEnvironment,
      payload: { repo: 'test/repo', description: 'internal snapshot setup' },
      status: RunStatus.Completed,
      completedAt: new Date(),
    });
    const normalRun = await runFactory.create({
      taskId: normalTask.id,
      payloadKind: TaskPayloadKind.StandardTask,
      payload: { repo: 'test/repo', description: 'Ship the useful task.' },
      status: RunStatus.Completed,
      completedAt: new Date(),
    });
    createdRunIds.push(snapshotRun.id, normalRun.id);
    await maybeEnqueueBrainMemoryEvent(db, snapshotRun.id);
    await maybeEnqueueBrainMemoryEvent(db, normalRun.id);

    await drainOneBatch({ baseUrl: brainUrl, token: 'local-test-token' });

    const events = await db
      .select()
      .from(brainMemoryEvents)
      .where(eq(brainMemoryEvents.runId, snapshotRun.id));
    const normalEvents = await db
      .select()
      .from(brainMemoryEvents)
      .where(eq(brainMemoryEvents.runId, normalRun.id));

    expect(events[0]).toMatchObject({
      status: 'skipped',
      lastError: 'snapshot environment maintenance task',
    });
    expect(normalEvents[0]?.status).toBe('done');
    expect(receivedBodies).toHaveLength(1);
    expect(receivedBodies[0]).toContain('put_page');
  });
});
