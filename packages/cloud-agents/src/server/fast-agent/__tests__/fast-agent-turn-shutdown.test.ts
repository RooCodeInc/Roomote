import { FastAgentProcessShutdownError } from '../fast-agent-turn-lock';
import {
  DEFAULT_FAST_AGENT_SHUTDOWN_DRAIN_MS,
  drainAndAbortFastAgentTurns,
  resolveFastAgentShutdownDrainMs,
} from '../fast-agent-turn-shutdown';

describe('resolveFastAgentShutdownDrainMs', () => {
  it('defaults to a bounded drain window', () => {
    expect(resolveFastAgentShutdownDrainMs(['A'], {})).toBe(
      DEFAULT_FAST_AGENT_SHUTDOWN_DRAIN_MS,
    );
    expect(resolveFastAgentShutdownDrainMs(['A'], { A: '' })).toBe(20_000);
    expect(resolveFastAgentShutdownDrainMs(['A'], { A: 'nope' })).toBe(20_000);
    expect(resolveFastAgentShutdownDrainMs(['A'], { A: '-5' })).toBe(20_000);
  });

  it('honors an explicit window, including the abort-immediately kill switch', () => {
    expect(resolveFastAgentShutdownDrainMs(['A'], { A: '5000' })).toBe(5_000);
    expect(resolveFastAgentShutdownDrainMs(['A'], { A: '0' })).toBe(0);
  });

  it('reads the first key that is set so a service can fall back to a shared one', () => {
    expect(resolveFastAgentShutdownDrainMs(['A', 'B'], { B: '7000' })).toBe(
      7_000,
    );
    expect(
      resolveFastAgentShutdownDrainMs(['A', 'B'], { A: '3000', B: '7000' }),
    ).toBe(3_000);
    expect(resolveFastAgentShutdownDrainMs(['A', 'B'], { A: '', B: '0' })).toBe(
      0,
    );
  });
});

describe('drainAndAbortFastAgentTurns', () => {
  it('closes admissions, waits out the window, then aborts the stragglers', async () => {
    const reason = new FastAgentProcessShutdownError('SIGTERM');
    const order: string[] = [];
    const beginDrain = vi.fn(() => order.push('begin'));
    const onDrainStarted = vi.fn(() => order.push('started'));
    let finishDrain: ((remaining: number) => void) | undefined;
    const waitForTurns = vi.fn(
      () =>
        new Promise<number>((resolve) => {
          order.push('wait');
          finishDrain = resolve;
        }),
    );
    const abortTurns = vi.fn(async () => {
      order.push('abort');
      return 2;
    });
    const logWarn = vi.fn();

    const result = drainAndAbortFastAgentTurns(
      { reason, drainMs: 1_500, service: 'bullmq', onDrainStarted, logWarn },
      { beginDrain, waitForTurns, abortTurns },
    );

    expect(beginDrain).toHaveBeenCalledWith(reason);
    expect(waitForTurns).toHaveBeenCalledWith(1_500);
    expect(abortTurns).not.toHaveBeenCalled();

    finishDrain?.(2);
    await expect(result).resolves.toBe(2);
    expect(order).toEqual(['begin', 'started', 'wait', 'abort']);
    expect(abortTurns).toHaveBeenCalledWith(reason);
    expect(logWarn).toHaveBeenCalledWith(
      '[bullmq] Aborting 2 Fast turn(s) still active after the 1500ms shutdown drain.',
    );
  });

  it('stays quiet when every turn settles inside the window', async () => {
    const logWarn = vi.fn();
    const abortTurns = vi.fn().mockResolvedValue(0);

    await drainAndAbortFastAgentTurns(
      {
        reason: new FastAgentProcessShutdownError('SIGINT'),
        drainMs: 0,
        service: 'api',
        logWarn,
      },
      {
        beginDrain: vi.fn(),
        waitForTurns: vi.fn().mockResolvedValue(0),
        abortTurns,
      },
    );

    expect(logWarn).not.toHaveBeenCalled();
    expect(abortTurns).toHaveBeenCalledOnce();
  });
});
