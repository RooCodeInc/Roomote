const mocks = vi.hoisted(() => {
  class FastAgentParentEventDeliveryError extends Error {
    readonly replyPosted: boolean;
    readonly permanent: boolean;

    constructor(
      message: string,
      options: { replyPosted: boolean; permanent?: boolean },
    ) {
      super(message);
      this.replyPosted = options.replyPosted;
      this.permanent = options.permanent ?? false;
    }
  }

  return {
    claimReturning: vi.fn(),
    updateSet: vi.fn(),
    sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings: [...strings],
      values,
    })),
    FastAgentParentEventDeliveryError,
  };
});

vi.mock('@roomote/db/server', () => ({
  db: {
    update: vi.fn(() => ({
      set: vi.fn((values: unknown) => {
        mocks.updateSet(values);
        return {
          where: vi.fn(() => ({ returning: mocks.claimReturning })),
        };
      }),
    })),
  },
  and: vi.fn((...args: unknown[]) => args),
  eq: vi.fn((...args: unknown[]) => args),
  sql: mocks.sql,
  taskRuns: {
    id: 'task_runs.id',
    result: 'task_runs.result',
  },
}));

vi.mock('../../fast-agent-parent-event', () => ({
  FastAgentParentEventDeliveryError: mocks.FastAgentParentEventDeliveryError,
}));

import { deliverFastAgentParentPrEvent } from '../deliver-fast-agent-parent-pr-event';

const run = { id: 200, taskId: 'child-task' };
const deliveryKey = 'fastAgentParentPr:test';

function deliver(params?: {
  deliver?: () => Promise<'delivered' | 'skipped'>;
  recordLifecycle?: () => Promise<void>;
}) {
  return deliverFastAgentParentPrEvent({
    run,
    deliveryKey,
    logPrefix: 'testFastParentPrEvent',
    deliver: params?.deliver ?? vi.fn().mockResolvedValue('delivered'),
    recordLifecycle:
      params?.recordLifecycle ?? vi.fn().mockResolvedValue(undefined),
  });
}

function hasResultSql(fragment: string): boolean {
  return mocks.updateSet.mock.calls.some(([values]) => {
    const result = (values as { result?: { strings?: string[] } }).result;
    return result?.strings?.join('').includes(fragment) === true;
  });
}

describe('deliverFastAgentParentPrEvent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.claimReturning.mockResolvedValue([{ id: run.id }]);
  });

  it('claims the event with stale-lease recovery before delivering it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-21T12:00:00Z'));
    const deliverEvent = vi.fn().mockResolvedValue('delivered');
    const recordLifecycle = vi.fn().mockResolvedValue(undefined);

    await deliver({ deliver: deliverEvent, recordLifecycle });

    expect(deliverEvent).toHaveBeenCalledOnce();
    expect(recordLifecycle).toHaveBeenCalledOnce();
    expect(hasResultSql('to_jsonb(now())')).toBe(true);
    expect(
      mocks.sql.mock.calls.some(([, ...values]) =>
        values.includes(Date.now() - 15 * 60 * 1000),
      ),
    ).toBe(true);
    vi.useRealTimers();
  });

  it('does not deliver when another caller owns or settled the claim', async () => {
    mocks.claimReturning.mockResolvedValue([]);
    const deliverEvent = vi.fn().mockResolvedValue('delivered');

    await deliver({ deliver: deliverEvent });

    expect(deliverEvent).not.toHaveBeenCalled();
  });

  it('settles a skipped delivery without recording lifecycle history', async () => {
    const recordLifecycle = vi.fn().mockResolvedValue(undefined);

    await deliver({
      deliver: vi.fn().mockResolvedValue('skipped'),
      recordLifecycle,
    });

    expect(recordLifecycle).not.toHaveBeenCalled();
    expect(hasResultSql('to_jsonb(now())')).toBe(true);
  });

  it('releases a transient failure so a later caller can retry', async () => {
    await expect(
      deliver({
        deliver: vi.fn().mockRejectedValue(new Error('model offline')),
      }),
    ).rejects.toThrow('model offline');

    expect(hasResultSql(' - ')).toBe(true);
  });

  it.each([
    { replyPosted: true, permanent: false },
    { replyPosted: false, permanent: true },
  ])(
    'settles a non-retryable delivery error: %o',
    async ({ replyPosted, permanent }) => {
      await expect(
        deliver({
          deliver: vi.fn().mockRejectedValue(
            new mocks.FastAgentParentEventDeliveryError('delivery failed', {
              replyPosted,
              permanent,
            }),
          ),
        }),
      ).resolves.toBeUndefined();

      expect(hasResultSql('to_jsonb(now())')).toBe(true);
      expect(hasResultSql(' - ')).toBe(false);
    },
  );

  it('does not retry after delivery succeeds but lifecycle recording fails', async () => {
    await expect(
      deliver({
        recordLifecycle: vi
          .fn()
          .mockRejectedValue(new Error('lifecycle unavailable')),
      }),
    ).resolves.toBeUndefined();

    expect(hasResultSql('to_jsonb(now())')).toBe(true);
    expect(hasResultSql(' - ')).toBe(false);
  });
});
