import { NextRequest } from 'next/server';
import {
  db,
  eq,
  runFactory,
  taskFactory,
  taskRuns,
  userFactory,
} from '@roomote/db/server';
import { RunStatus } from '@roomote/types';

const { authorizeUserToken, push, createResponse } = vi.hoisted(() => ({
  authorizeUserToken: vi.fn(),
  push: vi.fn(),
  createResponse: vi.fn(),
}));
vi.mock('@/lib/server', () => ({ authorizeUserToken }));
vi.mock('better-sse', () => ({ createResponse }));

import { GET } from './route';

describe('task run progress stream projection', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    createResponse.mockImplementation(async (_request, callback) => {
      await callback({ isConnected: true, push });
      return new Response('stream');
    });
  });

  it('sends only public progress on every poll for owners and other members', async () => {
    const owner = await userFactory.create();
    const other = await userFactory.create();
    const task = await taskFactory.create({ initiatorUserId: owner.id });
    const run = await runFactory.create({
      taskId: task.id,
      status: RunStatus.Failed,
      vendor: 'modal',
      authBypassValue: 'fake-preview-bypass-secret',
      authBypassHeaderName: 'x-fake-preview-bypass',
      machineId: 'private-machine',
      result: { error: 'Public failure', credentials: 'fake-result-secret' },
    });
    const request = new NextRequest('http://localhost/api/task-runs/1/stream');
    for (const userId of [owner.id, other.id]) {
      push.mockClear();
      authorizeUserToken.mockResolvedValue({
        success: true,
        userId,
        isAdmin: false,
      });
      expect(
        (
          await GET(request, {
            params: Promise.resolve({ id: String(run.id) }),
          })
        ).status,
      ).toBe(200);
      expect(push.mock.calls).toEqual([
        [
          {
            id: run.id,
            taskId: task.id,
            status: RunStatus.Failed,
            vendor: 'modal',
            error: 'Public failure',
            errorCode: null,
          },
          'message',
        ],
        [null, 'disconnect'],
      ]);
    }

    // Exercise the same projection after a poll observes a changed row.
    await db
      .update(taskRuns)
      .set({ status: RunStatus.Pending })
      .where(eq(taskRuns.id, run.id));
    push.mockClear();
    push.mockImplementationOnce(async () => {
      await db
        .update(taskRuns)
        .set({ status: RunStatus.Failed, error: 'New failure' })
        .where(eq(taskRuns.id, run.id));
    });
    await GET(request, { params: Promise.resolve({ id: String(run.id) }) });
    expect(push.mock.calls).toEqual([
      [
        {
          id: run.id,
          taskId: task.id,
          status: RunStatus.Pending,
          vendor: 'modal',
          error: 'Public failure',
          errorCode: null,
        },
        'message',
      ],
      [
        {
          id: run.id,
          taskId: task.id,
          status: RunStatus.Failed,
          vendor: 'modal',
          error: 'New failure',
          errorCode: null,
        },
        'message',
      ],
      [null, 'disconnect'],
    ]);
  });

  it('denies anonymous requests before querying or opening the stream', async () => {
    authorizeUserToken.mockResolvedValue({ success: false });
    expect(
      (
        await GET(new NextRequest('http://localhost/api/task-runs/1/stream'), {
          params: Promise.resolve({ id: '1' }),
        })
      ).status,
    ).toBe(401);
    expect(createResponse).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });
});
