import * as os from 'node:os';
import * as path from 'node:path';
import type { PathLike } from 'node:fs';

import { execa } from 'execa';

const {
  mockExeca,
  mockExistsSync,
  mockMkdirSync,
  mockWriteFileSync,
  mockChmodSync,
  mockResolveWorkerRuntimePaths,
} = vi.hoisted(() => ({
  mockExeca: vi.fn(),
  mockExistsSync: vi.fn(),
  mockMkdirSync: vi.fn(),
  mockWriteFileSync: vi.fn(),
  mockChmodSync: vi.fn(),
  mockResolveWorkerRuntimePaths: vi.fn(() => ({
    runtime: 'modal',
    sandboxRootDir: '/sandbox',
    workspaceReposDir: '/sandbox/repos',
    vscodeUserDataDir: '/sandbox/.vscode',
  })),
}));

vi.mock('execa', () => ({
  execa: mockExeca,
}));

vi.mock('node:fs', () => ({
  existsSync: mockExistsSync,
  mkdirSync: mockMkdirSync,
  writeFileSync: mockWriteFileSync,
  chmodSync: mockChmodSync,
}));

vi.mock('@roomote/types', () => ({
  resolveWorkerRuntimePaths: mockResolveWorkerRuntimePaths,
}));

import {
  DEFAULT_OPENCODE_CLI_VERSION,
  DEFAULT_ZERO_CLI_VERSION,
  ROOMOTE_BAKED_OPENCODE_CLI_VERSION_ENV,
  ROOMOTE_BAKED_ZERO_CLI_VERSION_ENV,
  ROOMOTE_OPENCODE_CLI_VERSION_ENV,
  ROOMOTE_ZERO_CLI_VERSION_ENV,
  installAgentClis,
  installZeroCli,
} from '../agent-clis';
import type { StartupLogger } from '../../../logging';

const MISE_NPM_PATH = '/opt/mise/installs/node/22.17.1/bin/npm';

function versionResult(output: string) {
  return {
    exitCode: 0,
    stdout: output,
    stderr: '',
  } as Awaited<ReturnType<typeof execa>>;
}

function installResult() {
  return {
    exitCode: 0,
    stdout: '',
    stderr: '',
  } as Awaited<ReturnType<typeof execa>>;
}

describe('installAgentClis', () => {
  const originalEnv = { ...process.env };
  const logger = {
    userLog: { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    debug: { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    setFilePath: vi.fn(),
  } as unknown as StartupLogger;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env[ROOMOTE_OPENCODE_CLI_VERSION_ENV];
    delete process.env[ROOMOTE_BAKED_OPENCODE_CLI_VERSION_ENV];
    delete process.env[ROOMOTE_ZERO_CLI_VERSION_ENV];
    delete process.env[ROOMOTE_BAKED_ZERO_CLI_VERSION_ENV];

    mockExistsSync.mockImplementation((targetPath: PathLike) => {
      return targetPath === '/sandbox';
    });
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('skips reinstall when opencode already matches the expected version', async () => {
    mockExeca
      .mockResolvedValueOnce(versionResult(MISE_NPM_PATH))
      .mockResolvedValueOnce(versionResult(DEFAULT_OPENCODE_CLI_VERSION));

    await installAgentClis(logger);

    expect(mockExeca).toHaveBeenCalledTimes(2);
    expect(mockExeca).toHaveBeenNthCalledWith(
      1,
      'bash',
      ['-lc', 'mise which npm'],
      {
        reject: false,
        stdin: 'ignore',
      },
    );
    expect(mockExeca).toHaveBeenNthCalledWith(2, 'opencode', ['--version'], {
      reject: false,
      stdin: 'ignore',
    });
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it('reinstalls opencode into the sandbox root and refreshes the launcher when an older image is missing it', async () => {
    mockExeca
      .mockResolvedValueOnce(versionResult(MISE_NPM_PATH))
      .mockRejectedValueOnce(new Error('spawn opencode ENOENT'))
      .mockResolvedValueOnce(installResult())
      .mockResolvedValueOnce(versionResult(DEFAULT_OPENCODE_CLI_VERSION))
      .mockResolvedValueOnce(versionResult(DEFAULT_OPENCODE_CLI_VERSION));

    await installAgentClis(logger);

    expect(mockExeca).toHaveBeenNthCalledWith(
      3,
      MISE_NPM_PATH,
      [
        'install',
        '--prefix',
        '/sandbox',
        '--no-save',
        '--no-package-lock',
        `opencode-ai@${DEFAULT_OPENCODE_CLI_VERSION}`,
        'node-pty',
      ],
      {
        stdin: 'ignore',
      },
    );
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      path.join(os.homedir(), '.local', 'bin', 'opencode'),
      '#!/bin/bash\nexec "/sandbox/node_modules/.bin/opencode" "$@"\n',
      'utf8',
    );
  });

  it('prefers the baked opencode version when available', async () => {
    process.env[ROOMOTE_BAKED_OPENCODE_CLI_VERSION_ENV] = '1.18.0';

    mockExeca
      .mockResolvedValueOnce(versionResult(MISE_NPM_PATH))
      .mockRejectedValueOnce(new Error('spawn opencode ENOENT'))
      .mockResolvedValueOnce(installResult())
      .mockResolvedValueOnce(versionResult('1.18.0'))
      .mockResolvedValueOnce(versionResult('1.18.0'));

    await installAgentClis(logger);

    expect(mockExeca).toHaveBeenNthCalledWith(
      3,
      MISE_NPM_PATH,
      [
        'install',
        '--prefix',
        '/sandbox',
        '--no-save',
        '--no-package-lock',
        'opencode-ai@1.18.0',
        'node-pty',
      ],
      {
        stdin: 'ignore',
      },
    );
  });
});

describe('installZeroCli', () => {
  const originalEnv = { ...process.env };
  const logger = {
    userLog: { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    debug: { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    setFilePath: vi.fn(),
  } as unknown as StartupLogger;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env[ROOMOTE_ZERO_CLI_VERSION_ENV];
    delete process.env[ROOMOTE_BAKED_ZERO_CLI_VERSION_ENV];
    mockExistsSync.mockImplementation((targetPath: PathLike) => {
      return targetPath === '/sandbox';
    });
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('skips reinstall when zero already matches the expected version', async () => {
    mockExeca
      .mockResolvedValueOnce(versionResult(MISE_NPM_PATH))
      .mockResolvedValueOnce(versionResult(DEFAULT_ZERO_CLI_VERSION));

    await installZeroCli(logger);

    expect(mockExeca).toHaveBeenCalledTimes(2);
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it('installs zero into its own prefix so npm cannot prune the shared sandbox packages', async () => {
    mockExeca
      .mockResolvedValueOnce(versionResult(MISE_NPM_PATH))
      .mockRejectedValueOnce(new Error('spawn zero ENOENT'))
      .mockResolvedValueOnce(installResult())
      .mockResolvedValueOnce(versionResult(DEFAULT_ZERO_CLI_VERSION))
      .mockResolvedValueOnce(versionResult(DEFAULT_ZERO_CLI_VERSION));

    await installZeroCli(logger);

    expect(mockExeca).toHaveBeenNthCalledWith(
      3,
      MISE_NPM_PATH,
      [
        'install',
        '--prefix',
        '/sandbox/zero-cli',
        '--no-save',
        '--no-package-lock',
        `@zeroxyz/cli@${DEFAULT_ZERO_CLI_VERSION}`,
      ],
      {
        stdin: 'ignore',
      },
    );
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      path.join(os.homedir(), '.local', 'bin', 'zero'),
      '#!/bin/bash\nexec "/sandbox/zero-cli/node_modules/.bin/zero" "$@"\n',
      'utf8',
    );
  });
});
