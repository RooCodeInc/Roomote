import { callTRPCProcedure } from '@trpc/server';

import { logger } from '@/lib/server/logger';

import { createRouter, protectedProcedure, publicProcedure } from '../init';

vi.mock('@/lib/server/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const { authorizeMock } = vi.hoisted(() => ({ authorizeMock: vi.fn() }));

vi.mock('@/lib/server', () => ({
  authorize: authorizeMock,
}));

vi.mock('@/trpc/error-logging', () => ({
  shouldReportTrpcProcedureError: vi.fn(() => false),
  enrichTrpcClientErrorDetails: vi.fn(),
  reportTrpcProcedureError: vi.fn(),
  getTrpcClientErrorDetails: vi.fn(() => null),
}));

const infoMock = vi.mocked(logger.info);

const router = createRouter({
  ping: publicProcedure.query(() => 'pong'),
  boom: publicProcedure.query(() => {
    throw new Error('kaboom');
  }),
  secret: protectedProcedure.query(() => 'classified'),
});

function call(path: string, auth: { success: boolean }) {
  return callTRPCProcedure({
    router,
    path,
    ctx: { auth },
    type: 'query',
    getRawInput: async () => undefined,
    signal: undefined,
    batchIndex: 0,
  }) as Promise<unknown>;
}

describe('procedure timing wiring', () => {
  const originalThreshold = process.env.R_SLOW_PROCEDURE_LOG_MS;

  beforeEach(() => {
    vi.clearAllMocks();
    // Log every procedure so the assertions do not depend on real durations.
    process.env.R_SLOW_PROCEDURE_LOG_MS = '0';
    vi.spyOn(performance, 'now').mockReturnValue(0);
  });

  afterEach(() => {
    vi.restoreAllMocks();

    if (originalThreshold === undefined) {
      delete process.env.R_SLOW_PROCEDURE_LOG_MS;
    } else {
      process.env.R_SLOW_PROCEDURE_LOG_MS = originalThreshold;
    }
  });

  it('times public procedures without changing their result', async () => {
    await expect(call('ping', { success: true })).resolves.toBe('pong');

    expect(infoMock).toHaveBeenCalledWith(
      '[procedure-timing] procedure=ping ms=0 ok=true',
    );
  });

  it('times failing procedures without changing the error', async () => {
    await expect(call('boom', { success: true })).rejects.toThrow('kaboom');

    expect(infoMock).toHaveBeenCalledWith(
      '[procedure-timing] procedure=boom ms=0 ok=false',
    );
  });

  it('times protected procedures, including their auth rejection', async () => {
    await expect(call('secret', { success: true })).resolves.toBe('classified');
    await expect(call('secret', { success: false })).rejects.toThrow(
      'UNAUTHORIZED',
    );

    expect(infoMock.mock.calls.map(([line]) => line)).toEqual([
      '[procedure-timing] procedure=secret ms=0 ok=true',
      '[procedure-timing] procedure=secret ms=0 ok=false',
    ]);
  });
});
