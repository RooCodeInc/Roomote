const mocks = vi.hoisted(() => {
  class FastAgentParentEventDeliveryError extends Error {
    readonly slackPosted: boolean;
    readonly permanent: boolean;

    constructor(
      message: string,
      options: { slackPosted: boolean; permanent?: boolean },
    ) {
      super(message);
      this.slackPosted = options.slackPosted;
      this.permanent = options.permanent ?? false;
    }
  }

  return {
    claimReturning: vi.fn(),
    updateSet: vi.fn(),
    updateWhere: vi.fn(),
    FastAgentParentEventDeliveryError,
  };
});

vi.mock('@roomote/db/server', () => ({
  db: {
    update: vi.fn(() => ({
      set: vi.fn((values: unknown) => {
        mocks.updateSet(values);
        return {
          where: vi.fn((predicate: unknown) => {
            mocks.updateWhere(predicate);
            return { returning: mocks.claimReturning };
          }),
        };
      }),
    })),
  },
  and: vi.fn((...args: unknown[]) => args),
  eq: vi.fn((...args: unknown[]) => args),
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
    strings: [...strings],
    values,
  })),
  taskRuns: {
    id: 'task_runs.id',
    result: 'task_runs.result',
  },
}));

vi.mock('../../fast-agent-parent-event', () => ({
  FastAgentParentEventDeliveryError: mocks.FastAgentParentEventDeliveryError,
}));

import { runFastAgentParentEventLifecycle } from '../fast-agent-parent-event-lifecycle';
import { buildFastAgentDeliveringMarker } from '../fast-agent-delivery-claim';

function expectOwnedClaimWrite(predicate: unknown, claimMarker: string) {
  expect(predicate).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        values: expect.arrayContaining(['delivery-key', claimMarker]),
      }),
    ]),
  );
}

function getClaimMarker(): string {
  const marker = mocks.updateSet.mock.calls
    .flatMap(([values]) => {
      const result = (values as { result?: { values?: unknown[] } }).result;
      return result?.values ?? [];
    })
    .find(
      (value): value is string =>
        typeof value === 'string' && value.startsWith('delivering:'),
    );
  expect(marker).toBeDefined();
  return marker!;
}

describe('runFastAgentParentEventLifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Date, 'now').mockReturnValue(1234);
    mocks.claimReturning.mockResolvedValue([{ id: 200 }]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fences delivery finalization to the acquired lease', async () => {
    await expect(
      runFastAgentParentEventLifecycle({
        runId: 200,
        deliveryKey: 'delivery-key',
        deliver: vi.fn().mockResolvedValue('delivered'),
        recordDelivered: vi.fn().mockResolvedValue(undefined),
      }),
    ).resolves.toEqual({ status: 'delivered' });

    expectOwnedClaimWrite(
      mocks.updateWhere.mock.calls.at(-1)?.[0],
      getClaimMarker(),
    );
  });

  it('fences transient claim release to the acquired lease', async () => {
    await expect(
      runFastAgentParentEventLifecycle({
        runId: 200,
        deliveryKey: 'delivery-key',
        deliver: vi.fn().mockRejectedValue(new Error('model offline')),
        recordDelivered: vi.fn(),
      }),
    ).resolves.toMatchObject({ status: 'failed' });

    expectOwnedClaimWrite(
      mocks.updateWhere.mock.calls.at(-1)?.[0],
      getClaimMarker(),
    );
  });

  it('uses distinct lease tokens when claims start in the same millisecond', () => {
    const first = buildFastAgentDeliveringMarker();
    const second = buildFastAgentDeliveringMarker();

    expect(first).toMatch(/^delivering:1234:[0-9a-f-]{36}$/);
    expect(second).toMatch(/^delivering:1234:[0-9a-f-]{36}$/);
    expect(first).not.toBe(second);
  });
});
