import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockCaptureEvent, txState } = vi.hoisted(() => ({
  mockCaptureEvent: vi.fn(),
  txState: {
    rows: [] as Array<{ setupNewState: Record<string, unknown> | null }>,
    updates: [] as Array<Record<string, unknown>>,
    lockCalls: [] as unknown[],
  },
}));

vi.mock('@roomote/telemetry/server', () => ({
  captureEvent: (...args: unknown[]) => mockCaptureEvent(...args),
}));

vi.mock('@roomote/db/server', () => {
  const makeUpdate = (executor: {
    updates: Array<Record<string, unknown>>;
  }) => ({
    set: (values: Record<string, unknown>) => {
      executor.updates.push(values);
      return {
        where: () => Promise.resolve(),
      };
    },
  });
  const makeTx = () => ({
    execute: (query: unknown) => {
      txState.lockCalls.push(query);
      return Promise.resolve();
    },
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(txState.rows),
        }),
      }),
    }),
    update: () =>
      makeUpdate(
        txState as never as { updates: Array<Record<string, unknown>> },
      ),
  });

  return {
    db: {
      transaction: (fn: (tx: unknown) => Promise<void>) => fn(makeTx()),
    },
    and: (...parts: unknown[]) => parts,
    deploymentSettings: {
      id: 'deploymentSettings.id',
      setupNewState: 'deploymentSettings.setupNewState',
      updatedAt: 'deploymentSettings.updatedAt',
    },
    eq: (a: unknown, b: unknown) => [a, b],
    sql: (parts: TemplateStringsArray) => parts.join(''),
  };
});

import { recordSetupSessionTaskCompleted } from '../setup-session-task-completed';

const conversationId = '11111111-1111-4111-8111-111111111111';

function persistedState(milestones: Record<string, string>) {
  return {
    rows: [
      {
        setupNewState: {
          version: 1,
          setupSession: {
            sessionId: conversationId,
            conversationId,
            starterLaunchBatchId: `setup-batch-${conversationId}`,
            milestones,
            completedAt: '2026-08-29T00:00:00.000Z',
          },
        },
      },
    ],
  };
}

describe('recordSetupSessionTaskCompleted', () => {
  beforeEach(() => {
    mockCaptureEvent.mockClear();
    txState.rows = [];
    txState.updates = [];
    txState.lockCalls = [];
  });

  it('records the milestone and telemetry once for the setup session', async () => {
    txState.rows = persistedState({
      session_created: '2026-08-29T00:00:00.000Z',
    }).rows;

    await recordSetupSessionTaskCompleted({
      conversationId,
      status: 'completed',
    });

    expect(txState.updates).toHaveLength(1);
    const update = txState.updates[0] as {
      setupNewState: { setupSession: { milestones: Record<string, string> } };
    };
    expect(
      update.setupNewState.setupSession.milestones.first_task_completed,
    ).toBeTypeOf('string');
    expect(mockCaptureEvent).toHaveBeenCalledWith(
      'setup_session_task_completed',
      { properties: { status: 'completed' } },
    );
  });

  it('is a no-op for conversations that are not the setup session', async () => {
    txState.rows = persistedState({}).rows;

    await recordSetupSessionTaskCompleted({
      conversationId: '22222222-2222-4222-8222-222222222222',
      status: 'completed',
    });

    expect(txState.updates).toHaveLength(0);
    expect(mockCaptureEvent).not.toHaveBeenCalled();
  });

  it('is a no-op when the milestone already exists', async () => {
    txState.rows = persistedState({
      first_task_completed: '2026-08-29T01:00:00.000Z',
    }).rows;

    await recordSetupSessionTaskCompleted({
      conversationId,
      status: 'completed',
    });

    expect(txState.updates).toHaveLength(0);
    expect(mockCaptureEvent).not.toHaveBeenCalled();
  });

  it('is a no-op when no setup session is persisted', async () => {
    txState.rows = [{ setupNewState: null }];

    await recordSetupSessionTaskCompleted({
      conversationId,
      status: 'completed',
    });

    expect(txState.updates).toHaveLength(0);
    expect(mockCaptureEvent).not.toHaveBeenCalled();
  });
});
