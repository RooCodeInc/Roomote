vi.mock('@roomote/cloud-agents/server', () => ({
  evaluateChannelLaunchCriteria: vi.fn(),
}));

vi.mock('../../logging.js', () => ({
  apiLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

import { evaluateChannelLaunchCriteria } from '@roomote/cloud-agents/server';
import type { Redis } from '@roomote/redis';

import { evaluateChannelLaunchGate } from './channel-launch-gate.js';

const mockEvaluateChannelLaunchCriteria = vi.mocked(
  evaluateChannelLaunchCriteria,
);

function createHistoryTransactionStub() {
  const transaction = {
    lpush: vi.fn(),
    ltrim: vi.fn(),
    expire: vi.fn(),
    exec: vi.fn().mockResolvedValue([]),
  };
  transaction.lpush.mockReturnValue(transaction);
  transaction.ltrim.mockReturnValue(transaction);
  transaction.expire.mockReturnValue(transaction);
  return transaction;
}

function createRedisStub(overrides: Partial<Record<string, unknown>> = {}) {
  const historyTransaction = createHistoryTransactionStub();
  return {
    redis: {
      get: vi.fn().mockResolvedValue(null),
      // `set` backs the per-channel gate lock; 'OK' means acquired.
      set: vi.fn().mockResolvedValue('OK'),
      eval: vi.fn().mockResolvedValue(1),
      lrange: vi.fn().mockResolvedValue([]),
      multi: vi.fn().mockReturnValue(historyTransaction),
      ...overrides,
    } as unknown as Redis,
    historyTransaction,
  };
}

const baseParams = {
  // The slack:-prefixed key assertions below double as the guarantee that the
  // shared module kept Slack's pre-existing Redis keys byte-identical.
  provider: 'slack' as const,
  channelId: 'CALERTS',
  channelName: 'external-alerts',
  messageText: 'Elevated 431 Errors. Status: Identified.',
  botMentioned: false,
  launchCriteria: 'Launch for incidents affecting our providers.',
  isBotAuthored: true,
  logContext: 'configured channel auto-start CALERTS:1718000000.000100',
};

describe('evaluateChannelLaunchGate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('launches when the classifier approves and bumps the rate counter atomically', async () => {
    const { redis } = createRedisStub();
    mockEvaluateChannelLaunchCriteria.mockResolvedValueOnce({
      status: 'launch',
      reason: 'Provider outage matches the criteria.',
    });

    const result = await evaluateChannelLaunchGate({
      redis,
      ...baseParams,
    });

    expect(result).toEqual({
      shouldLaunch: true,
      debug: {
        llmDecision: 'launch',
        reason: 'Provider outage matches the criteria.',
      },
    });
    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('INCR', KEYS[1])"),
      1,
      'slack:launch-gate:rate:CALERTS',
      60 * 60,
    );
  });

  it('skips when the classifier says the criteria are not met', async () => {
    const { redis } = createRedisStub();
    mockEvaluateChannelLaunchCriteria.mockResolvedValueOnce({
      status: 'skip',
      reason: 'Resolved updates never launch.',
    });

    const result = await evaluateChannelLaunchGate({
      redis,
      ...baseParams,
    });

    expect(result).toEqual({
      shouldLaunch: false,
      skipReason: 'criteria_not_met',
      debug: {
        llmDecision: 'skip',
        reason: 'Resolved updates never launch.',
      },
    });
    expect(redis.eval).not.toHaveBeenCalledWith(
      expect.stringContaining("redis.call('INCR', KEYS[1])"),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it('skips before calling the classifier when the hourly launch cap is hit', async () => {
    const { redis } = createRedisStub({
      get: vi.fn().mockResolvedValue('25'),
    });

    const result = await evaluateChannelLaunchGate({
      redis,
      ...baseParams,
    });

    expect(result).toEqual({
      shouldLaunch: false,
      skipReason: 'rate_limited',
      debug: {
        llmDecision: 'not_run',
        reason:
          'Channel hit the 25/hour gated-launch cap before the LLM decision ran.',
      },
    });
    expect(mockEvaluateChannelLaunchCriteria).not.toHaveBeenCalled();
  });

  it('fails closed when the classifier errors', async () => {
    const { redis } = createRedisStub();
    mockEvaluateChannelLaunchCriteria.mockResolvedValueOnce({
      status: 'error',
      message: 'upstream timeout',
    });

    const result = await evaluateChannelLaunchGate({
      redis,
      ...baseParams,
    });

    expect(result).toEqual({
      shouldLaunch: false,
      skipReason: 'classifier_error',
      debug: {
        llmDecision: 'error',
        reason: 'The LLM launch decision failed: upstream timeout',
      },
    });
  });

  it('fails closed when the rate script errors', async () => {
    const { redis } = createRedisStub({
      eval: vi.fn().mockRejectedValue(new Error('redis down')),
    });
    mockEvaluateChannelLaunchCriteria.mockResolvedValueOnce({
      status: 'launch',
      reason: 'Provider outage matches the criteria.',
    });

    const result = await evaluateChannelLaunchGate({
      redis,
      ...baseParams,
    });

    expect(result).toEqual({
      shouldLaunch: false,
      skipReason: 'classifier_error',
      debug: {
        llmDecision: 'launch',
        reason:
          'Provider outage matches the criteria. Rate bookkeeping then failed: redis down',
      },
    });
  });

  it('feeds recent gate decisions to the classifier', async () => {
    const { redis } = createRedisStub({
      lrange: vi.fn().mockResolvedValue([
        JSON.stringify({
          at: Date.now() - 10 * 60_000,
          decision: 'launched',
          message: 'Elevated 431 Errors. Status: Investigating.',
        }),
        'not-json',
      ]),
    });
    mockEvaluateChannelLaunchCriteria.mockResolvedValueOnce({
      status: 'skip',
      reason: 'Repeat update of an incident that already launched.',
    });

    await evaluateChannelLaunchGate({
      redis,
      ...baseParams,
    });

    expect(mockEvaluateChannelLaunchCriteria).toHaveBeenCalledWith(
      expect.objectContaining({
        recentGateActivity: [
          {
            ageDescription: '10m ago',
            decision: 'launched',
            messageSnippet: 'Elevated 431 Errors. Status: Investigating.',
          },
        ],
      }),
    );
  });

  it('forwards bot mention metadata to the classifier', async () => {
    const { redis } = createRedisStub();
    mockEvaluateChannelLaunchCriteria.mockResolvedValueOnce({
      status: 'skip',
      reason: 'Missing tag.',
    });

    await evaluateChannelLaunchGate({
      redis,
      ...baseParams,
      botMentioned: true,
      messageText: '@Roomote (matt) Elevated 431 Errors. Status: Identified.',
    });

    expect(mockEvaluateChannelLaunchCriteria).toHaveBeenCalledWith(
      expect.objectContaining({
        botMentioned: true,
        messageText: '@Roomote (matt) Elevated 431 Errors. Status: Identified.',
      }),
    );
  });

  it('records launched and skipped decisions in the gate history', async () => {
    const { redis, historyTransaction } = createRedisStub();
    mockEvaluateChannelLaunchCriteria.mockResolvedValueOnce({
      status: 'launch',
      reason: 'Provider outage matches the criteria.',
    });

    await evaluateChannelLaunchGate({ redis, ...baseParams });

    expect(historyTransaction.lpush).toHaveBeenCalledWith(
      'slack:launch-gate:history:CALERTS',
      expect.stringContaining('"decision":"launched"'),
    );
    expect(historyTransaction.expire).toHaveBeenCalledWith(
      'slack:launch-gate:history:CALERTS',
      48 * 60 * 60,
    );

    mockEvaluateChannelLaunchCriteria.mockResolvedValueOnce({
      status: 'skip',
      reason: 'Resolved updates never launch.',
    });

    await evaluateChannelLaunchGate({ redis, ...baseParams });

    expect(historyTransaction.lpush).toHaveBeenCalledWith(
      'slack:launch-gate:history:CALERTS',
      expect.stringContaining('"decision":"skipped"'),
    );
  });

  it('serializes per channel and releases the gate lock afterwards', async () => {
    const { redis } = createRedisStub();
    mockEvaluateChannelLaunchCriteria.mockResolvedValueOnce({
      status: 'launch',
      reason: 'Provider outage matches the criteria.',
    });

    await evaluateChannelLaunchGate({ redis, ...baseParams });

    expect(redis.set).toHaveBeenCalledWith(
      'slack:launch-gate:lock:CALERTS',
      expect.any(String),
      'EX',
      30,
      'NX',
    );
    // The conditional-release Lua script runs against the lock key.
    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('del',KEYS[1])"),
      1,
      'slack:launch-gate:lock:CALERTS',
      expect.any(String),
    );
  });

  it('proceeds unserialized when the gate lock stays held', async () => {
    vi.useFakeTimers();
    try {
      const { redis } = createRedisStub({
        set: vi.fn().mockResolvedValue(null),
      });
      mockEvaluateChannelLaunchCriteria.mockResolvedValueOnce({
        status: 'launch',
        reason: 'Provider outage matches the criteria.',
      });

      const resultPromise = evaluateChannelLaunchGate({
        redis,
        ...baseParams,
      });
      await vi.advanceTimersByTimeAsync(20 * 500);
      const result = await resultPromise;

      expect(result.shouldLaunch).toBe(true);
      expect(redis.set).toHaveBeenCalledTimes(20);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stores history snippets as a single line', async () => {
    const { redis, historyTransaction } = createRedisStub();
    mockEvaluateChannelLaunchCriteria.mockResolvedValueOnce({
      status: 'launch',
      reason: 'Provider outage matches the criteria.',
    });

    await evaluateChannelLaunchGate({
      redis,
      ...baseParams,
      messageText: 'Elevated 431 Errors\n\nStatus: Identified\n- Chat\n- Audio',
    });

    const storedEntry = JSON.parse(
      historyTransaction.lpush.mock.calls[0]?.[1] as string,
    ) as { message: string };
    expect(storedEntry.message).toBe(
      'Elevated 431 Errors Status: Identified - Chat - Audio',
    );
  });

  it('collapses legacy multiline snippets when reading history', async () => {
    const { redis } = createRedisStub({
      lrange: vi.fn().mockResolvedValue([
        JSON.stringify({
          at: Date.now() - 10 * 60_000,
          decision: 'launched',
          message: 'Elevated 431 Errors\nStatus: Investigating.',
        }),
      ]),
    });
    mockEvaluateChannelLaunchCriteria.mockResolvedValueOnce({
      status: 'skip',
      reason: 'Repeat update.',
    });

    await evaluateChannelLaunchGate({ redis, ...baseParams });

    expect(mockEvaluateChannelLaunchCriteria).toHaveBeenCalledWith(
      expect.objectContaining({
        recentGateActivity: [
          expect.objectContaining({
            messageSnippet: 'Elevated 431 Errors Status: Investigating.',
          }),
        ],
      }),
    );
  });

  it('still evaluates the gate when history reads and writes fail', async () => {
    const { redis } = createRedisStub({
      lrange: vi.fn().mockRejectedValue(new Error('redis down')),
      multi: vi.fn(() => {
        throw new Error('redis down');
      }),
    });
    mockEvaluateChannelLaunchCriteria.mockResolvedValueOnce({
      status: 'launch',
      reason: 'Provider outage matches the criteria.',
    });

    const result = await evaluateChannelLaunchGate({
      redis,
      ...baseParams,
    });

    expect(result.shouldLaunch).toBe(true);
    expect(mockEvaluateChannelLaunchCriteria).toHaveBeenCalledWith(
      expect.objectContaining({ recentGateActivity: [] }),
    );
  });
});
