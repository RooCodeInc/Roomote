import { mkdir, open, rm, writeFile } from 'node:fs/promises';

import { appRouter } from '../../routers';
import type { Context } from '../../trpc';

const { logFileName } = vi.hoisted(() => ({
  logFileName: `get-harness-log-${process.pid}-${Date.now()}/harness.log`,
}));

vi.mock('../../../logging', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../logging')>()),
  HARNESS_LOG_FILE_NAME: logFileName,
}));

const HARNESS_LOG_PATH = `/tmp/${logFileName}`;
const FIXTURE_DIR = HARNESS_LOG_PATH.slice(
  0,
  HARNESS_LOG_PATH.lastIndexOf('/'),
);

function createCaller() {
  const ctx = {
    workingDirectory: '/tmp',
    harness: {
      isConnected: true,
      sendCommand: vi.fn(() => true),
      getPendingUserInputRequests: vi.fn(() => []),
    },
  } as unknown as Context;

  return appRouter.createCaller(ctx);
}

describe('getHarnessLog procedure', () => {
  beforeAll(async () => {
    await mkdir(FIXTURE_DIR);
  });
  afterEach(async () => {
    await rm(HARNESS_LOG_PATH, { recursive: true, force: true });
  });
  afterAll(async () => {
    await rm(FIXTURE_DIR, { recursive: true });
  });

  it('returns the requested tail of the actual harness log', async () => {
    await writeFile(HARNESS_LOG_PATH, 'one\ntwo\nthree\nfour');
    expect(
      await createCaller().commands.getHarnessLog({ lineLimit: 2 }),
    ).toEqual({
      path: HARNESS_LOG_PATH,
      exists: true,
      requestedLines: 2,
      returnedLines: 2,
      lines: ['three', 'four'],
    });
  });

  it('returns exists=false when the harness log has not been created yet', async () => {
    expect(
      await createCaller().commands.getHarnessLog({ lineLimit: 5 }),
    ).toEqual({
      path: HARNESS_LOG_PATH,
      exists: false,
      requestedLines: 5,
      returnedLines: 0,
      lines: [],
    });
  });

  it.each(['\n', '\r', '\r\n'])(
    'retains line semantics for %j endings across reads',
    async (ending) => {
      const longLine = '🦊'.repeat(20_000);
      await writeFile(
        HARNESS_LOG_PATH,
        `old${ending}${longLine}${ending}last🐋${ending}`,
      );
      expect(
        (await createCaller().commands.getHarnessLog({ lineLimit: 2 })).lines,
      ).toEqual([longLine, 'last🐋']);
    },
  );

  it('returns an empty tail for an existing empty file', async () => {
    await writeFile(HARNESS_LOG_PATH, '');
    expect(await createCaller().commands.getHarnessLog()).toMatchObject({
      exists: true,
      requestedLines: 200,
      returnedLines: 0,
      lines: [],
    });
  });

  it.each(['', '\n', '\r', '\r\n'])(
    'does not read a large discarded line before a short tail ending with %j',
    async (ending) => {
      await writeFile(
        HARNESS_LOG_PATH,
        `${'x'.repeat(8 * 1024 * 1024)}\none\ntwo${ending}`,
      );
      const file = await open(HARNESS_LOG_PATH, 'r');
      const prototype = Object.getPrototypeOf(file) as typeof file;
      await file.close();
      const reads = vi.spyOn(prototype, 'read');
      try {
        expect(
          (await createCaller().commands.getHarnessLog({ lineLimit: 2 })).lines,
        ).toEqual(['one', 'two']);
        const results = await Promise.all(
          reads.mock.results.map((result) => result.value),
        );
        const bytesRead = results.reduce(
          (total, result) => total + result.bytesRead,
          0,
        );
        expect(bytesRead).toBeLessThan(1024 * 1024);
      } finally {
        reads.mockRestore();
      }
    },
  );

  it('returns the default trailing window without dropping blank lines', async () => {
    await writeFile(
      HARNESS_LOG_PATH,
      `${'old\n'.repeat(20_000)}${'\n'.repeat(198)}one\ntwo\n`,
    );
    const result = await createCaller().commands.getHarnessLog();
    expect(result.returnedLines).toBe(200);
    expect(result.lines).toEqual([...Array(198).fill(''), 'one', 'two']);
  });

  it('propagates read errors other than a missing log', async () => {
    await mkdir(HARNESS_LOG_PATH);
    await expect(createCaller().commands.getHarnessLog()).rejects.toThrow(
      'EISDIR',
    );
  });
});
