import * as os from 'node:os';
import * as path from 'node:path';
import type { PathLike } from 'node:fs';

const {
  mockExistsSync,
  mockReadFileSync,
  mockAppendFileSync,
  mockMkdirSync,
  mockLstatSync,
  mockResolveWorkerRuntimePaths,
  mockIsComputeProvider,
} = vi.hoisted(() => ({
  mockExistsSync: vi.fn(),
  mockReadFileSync: vi.fn(),
  mockAppendFileSync: vi.fn(),
  mockMkdirSync: vi.fn(),
  mockLstatSync: vi.fn(),
  mockResolveWorkerRuntimePaths: vi.fn(() => ({
    runtime: 'sandbox-roomote-noble',
    workspaceReposDir: '/tmp/repos',
  })),
  mockIsComputeProvider: vi.fn(() => false),
}));

vi.mock('node:fs', () => ({
  existsSync: mockExistsSync,
  readFileSync: mockReadFileSync,
  appendFileSync: mockAppendFileSync,
  mkdirSync: mockMkdirSync,
  lstatSync: mockLstatSync,
}));

vi.mock('@roomote/types', () => ({
  isComputeProvider: mockIsComputeProvider,
  resolveWorkerRuntimePaths: mockResolveWorkerRuntimePaths,
}));

import { setupSystem } from '../system';
import type { StartupLogger } from '../../../logging';

describe('setupSystem', () => {
  const originalEnv = { ...process.env };
  const bashrcPath = path.join(os.homedir(), '.bashrc');

  const logger = {
    userLog: { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    debug: { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    setFilePath: vi.fn(),
  } as unknown as StartupLogger;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv, PATH: '/usr/bin' };
    delete process.env.LC_ALL;
    delete process.env.COREPACK_ENABLE_DOWNLOAD_PROMPT;
    delete process.env.SKIP_ENV_VALIDATION;
    delete process.env.DONT_PROMPT_WSL_INSTALL;
    delete process.env.COMPUTE_PROVIDER;
    delete process.env.WORKER_TARGET;
    delete process.env.MISE_DATA_DIR;

    mockExistsSync.mockImplementation((targetPath: PathLike) => {
      return (
        targetPath === '/usr/bin/apt-get' ||
        targetPath === bashrcPath ||
        targetPath === '/tmp/repos'
      );
    });
    mockReadFileSync.mockReturnValue('');
    mockLstatSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('sets up the worker environment without refreshing apt metadata', async () => {
    await setupSystem(logger);

    expect(mockMkdirSync).toHaveBeenCalledWith(
      path.join(os.homedir(), '.claude'),
      { recursive: true },
    );
    expect(logger.debug.log).toHaveBeenCalledWith(
      expect.stringContaining(
        'setupSystem: ensure workspace repos directory (done in ',
      ),
    );
    expect(logger.debug.warn).not.toHaveBeenCalled();
  });
});
