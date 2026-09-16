import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskPayloadKind } from '@roomote/types';

const mocks = vi.hoisted(() => {
  const where = vi.fn();
  const set = vi.fn(() => ({ where }));
  const update = vi.fn(() => ({ set }));
  return { where, set, update };
});

vi.mock('@roomote/db/server', () => ({
  db: { update: mocks.update },
  eq: vi.fn(() => 'task_run_id_match'),
  taskRuns: { id: 'task_runs.id' },
}));

import { prepareHostedWorkerLaunch } from './hosted-launch';

const taskRun = {
  id: 123,
  taskId: 'task_123',
  payloadKind: TaskPayloadKind.StandardTask,
  payload: {},
};

describe('hosted worker credential-egress launch handoff', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.where.mockResolvedValue(undefined);
  });

  it('merges bootstrap env, persists the command, then admits the workload', async () => {
    const order: string[] = [];
    mocks.where.mockImplementation(async () => {
      order.push('persist');
    });
    const admit = vi.fn(async () => {
      order.push('admit');
      return null;
    });
    const planApiProxy = vi.fn().mockResolvedValue({
      required: true,
      bootstrapEnv: { BOOTSTRAP_NONCE: 'nonce-1' },
      admit,
    });
    const launchHostedWorker = await prepareHostedWorkerLaunch({
      credentialEgress: { planApiProxy } as never,
      taskRun: taskRun as never,
      provider: 'azure',
    });

    const result = await launchHostedWorker(
      { BASE_ENV: 'base' },
      async (environment) => {
        order.push('launch');
        expect(environment).toEqual({
          BASE_ENV: 'base',
          BOOTSTRAP_NONCE: 'nonce-1',
        });
        return { commandId: 'cmd_123', exitCode: null };
      },
    );

    expect(result.commandId).toBe('cmd_123');
    expect(mocks.set).toHaveBeenCalledWith({ sandboxCmdId: 'cmd_123' });
    expect(order).toEqual(['launch', 'persist', 'admit']);
  });

  it('does not admit when launch validation or persistence fails', async () => {
    const admit = vi.fn();
    const launchHostedWorker = await prepareHostedWorkerLaunch({
      credentialEgress: {
        planApiProxy: vi.fn().mockResolvedValue({
          required: true,
          bootstrapEnv: {},
          admit,
        }),
      } as never,
      taskRun: taskRun as never,
      provider: 'box',
    });

    await expect(
      launchHostedWorker({}, async () => {
        throw new Error('invalid detached launch');
      }),
    ).rejects.toThrow('invalid detached launch');
    expect(mocks.update).not.toHaveBeenCalled();
    expect(admit).not.toHaveBeenCalled();

    mocks.where.mockRejectedValueOnce(new Error('command persistence failed'));
    await expect(
      launchHostedWorker({}, async () => ({ commandId: 'cmd_456' })),
    ).rejects.toThrow('command persistence failed');
    expect(admit).not.toHaveBeenCalled();
  });

  it('propagates admission failure after persisting the launched command', async () => {
    const admit = vi.fn().mockRejectedValue(new Error('admission failed'));
    const launchHostedWorker = await prepareHostedWorkerLaunch({
      credentialEgress: {
        planApiProxy: vi.fn().mockResolvedValue({
          required: true,
          bootstrapEnv: {},
          admit,
        }),
      } as never,
      taskRun: taskRun as never,
      provider: 'modal',
    });

    await expect(
      launchHostedWorker({}, async () => ({ commandId: 'cmd_789' })),
    ).rejects.toThrow('admission failed');
    expect(mocks.where).toHaveBeenCalledOnce();
    expect(admit).toHaveBeenCalledOnce();
  });
});
