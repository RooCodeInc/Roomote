import { logger } from '@/lib/server/logger';

import {
  describeRequestProcedures,
  getSlowProcedureLogThresholdMs,
  withProcedureTiming,
  withResponseCompletionTiming,
} from '../request-timing';

vi.mock('@/lib/server/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const infoMock = vi.mocked(logger.info);

describe('procedure timing', () => {
  const originalThreshold = process.env.R_SLOW_PROCEDURE_LOG_MS;
  let clock = 0;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.R_SLOW_PROCEDURE_LOG_MS;
    clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
  });

  afterEach(() => {
    vi.restoreAllMocks();

    if (originalThreshold === undefined) {
      delete process.env.R_SLOW_PROCEDURE_LOG_MS;
    } else {
      process.env.R_SLOW_PROCEDURE_LOG_MS = originalThreshold;
    }
  });

  const advance = (ms: number) => {
    clock += ms;
  };

  it('returns the procedure result unchanged', async () => {
    const result = { ok: true as const, data: { id: 'task-1' } };

    await expect(
      withProcedureTiming('tasks.get', async () => {
        advance(10);
        return result;
      }),
    ).resolves.toBe(result);
  });

  it('re-throws the original error untouched', async () => {
    const error = new Error('boom');

    await expect(
      withProcedureTiming('tasks.get', async () => {
        advance(10);
        throw error;
      }),
    ).rejects.toBe(error);
  });

  it('stays silent below the default threshold', async () => {
    await withProcedureTiming('tasks.get', async () => {
      advance(249);
      return { ok: true as const };
    });

    expect(infoMock).not.toHaveBeenCalled();
  });

  it('logs above the default threshold', async () => {
    await withProcedureTiming('tasks.get', async () => {
      advance(1500);
      return { ok: true as const };
    });

    expect(infoMock).toHaveBeenCalledTimes(1);
    expect(infoMock).toHaveBeenCalledWith(
      '[procedure-timing] procedure=tasks.get ms=1500 ok=true',
    );
  });

  it('reports ok=false for failed procedures', async () => {
    await withProcedureTiming('tasks.get', async () => {
      advance(400);
      return { ok: false as const };
    });

    await expect(
      withProcedureTiming('tasks.create', async () => {
        advance(400);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(infoMock.mock.calls.map(([line]) => line)).toEqual([
      '[procedure-timing] procedure=tasks.get ms=400 ok=false',
      '[procedure-timing] procedure=tasks.create ms=400 ok=false',
    ]);
  });

  it('honors R_SLOW_PROCEDURE_LOG_MS', async () => {
    process.env.R_SLOW_PROCEDURE_LOG_MS = '1000';

    await withProcedureTiming('tasks.get', async () => {
      advance(500);
      return { ok: true as const };
    });

    expect(infoMock).not.toHaveBeenCalled();

    await withProcedureTiming('tasks.get', async () => {
      advance(1000);
      return { ok: true as const };
    });

    expect(infoMock).toHaveBeenCalledTimes(1);
  });

  it('logs every procedure when the threshold is 0', async () => {
    process.env.R_SLOW_PROCEDURE_LOG_MS = '0';

    await withProcedureTiming('tasks.get', async () => {
      return { ok: true as const };
    });

    expect(infoMock).toHaveBeenCalledWith(
      '[procedure-timing] procedure=tasks.get ms=0 ok=true',
    );
  });

  it('falls back to the default threshold for unparseable values', () => {
    expect(getSlowProcedureLogThresholdMs({})).toBe(250);
    expect(
      getSlowProcedureLogThresholdMs({ R_SLOW_PROCEDURE_LOG_MS: '' }),
    ).toBe(250);
    expect(
      getSlowProcedureLogThresholdMs({ R_SLOW_PROCEDURE_LOG_MS: 'nope' }),
    ).toBe(250);
    expect(
      getSlowProcedureLogThresholdMs({ R_SLOW_PROCEDURE_LOG_MS: '-5' }),
    ).toBe(250);
    expect(
      getSlowProcedureLogThresholdMs({ R_SLOW_PROCEDURE_LOG_MS: ' 40 ' }),
    ).toBe(40);
  });

  it('strips characters that are not part of a tRPC path', async () => {
    process.env.R_SLOW_PROCEDURE_LOG_MS = '0';

    await withProcedureTiming('tasks.get\nfake=line', async () => ({
      ok: true as const,
    }));

    expect(infoMock).toHaveBeenCalledWith(
      '[procedure-timing] procedure=tasks.getfakeline ms=0 ok=true',
    );
  });
});

describe('describeRequestProcedures', () => {
  it('lists the batched procedure names', () => {
    expect(
      describeRequestProcedures(
        new URL('https://app.test/api/trpc/tasks.get,users.me?batch=1'),
      ),
    ).toEqual({ procedures: 'tasks.get,users.me', batch: 2 });
  });

  it('handles a single procedure', () => {
    expect(
      describeRequestProcedures(new URL('https://app.test/api/trpc/tasks.get')),
    ).toEqual({ procedures: 'tasks.get', batch: 1 });
  });

  it('handles a request without a procedure segment', () => {
    expect(
      describeRequestProcedures(new URL('https://app.test/api/trpc')),
    ).toEqual({ procedures: 'none', batch: 0 });
  });

  it('collapses very long batches to a count', () => {
    const names = Array.from({ length: 40 }, (_, index) => `tasks.get${index}`);
    const result = describeRequestProcedures(
      new URL(`https://app.test/api/trpc/${names.join(',')}`),
    );

    expect(result).toEqual({ procedures: '40-procedures', batch: 40 });
  });
});

describe('withResponseCompletionTiming', () => {
  it('preserves the body, status and headers and reports once the body ends', async () => {
    const onComplete = vi.fn();
    const response = withResponseCompletionTiming(
      new Response('chunk-one', {
        status: 207,
        headers: { 'content-type': 'application/json', 'x-test': 'kept' },
      }),
      onComplete,
    );

    expect(onComplete).not.toHaveBeenCalled();
    expect(response.status).toBe(207);
    expect(response.headers.get('x-test')).toBe('kept');
    expect(response.headers.get('content-type')).toBe('application/json');

    await expect(response.text()).resolves.toBe('chunk-one');
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('reports immediately when there is no body', () => {
    const onComplete = vi.fn();
    const original = new Response(null, { status: 204 });
    const response = withResponseCompletionTiming(original, onComplete);

    expect(response).toBe(original);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('reports once when the consumer cancels', async () => {
    const onComplete = vi.fn();
    const response = withResponseCompletionTiming(
      new Response('chunk-one'),
      onComplete,
    );

    await response.body?.cancel();

    expect(onComplete).toHaveBeenCalledTimes(1);
  });
});
