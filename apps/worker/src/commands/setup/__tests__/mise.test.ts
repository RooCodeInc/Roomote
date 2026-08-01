import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';

import { execa } from 'execa';

import type { StartupLogger } from '../../../logging';

const { mockIsCommandAvailable } = vi.hoisted(() => ({
  mockIsCommandAvailable: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}));

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

vi.mock('../command-availability', () => ({
  isCommandAvailable: mockIsCommandAvailable,
}));

import { RIPGREP_VERSION, installMise, installRipgrep } from '../mise';

const mockReadFile = vi.mocked(readFile);
const mockExeca = vi.mocked(execa);

const logger = {
  userLog: { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  debug: { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
} as unknown as StartupLogger;

/**
 * The exact bash -lc body used to enable Corepack yarn + reshim. Asserted
 * verbatim rather than by pattern: `enable` must name yarn and nothing else
 * (unscoped, or with pnpm appended, it plants pnpm/pnpx shims that shadow the
 * mise-managed pnpm), `reshim` must take no tool argument, and the steps must
 * be chained with `&&` so a corepack failure reaches the catch below instead of
 * being masked by a successful reshim.
 */
const COREPACK_YARN_ENABLE_SCRIPT =
  'corepack enable yarn && corepack prepare yarn@stable --activate && mise reshim';

const COREPACK_ENABLE_TIMEOUT_MS = 120_000;
const YARN_PROBE_TIMEOUT_MS = 30_000;

/** The `bash -lc` script bodies passed to execa, in call order. */
function bashScripts(): string[] {
  return mockExeca.mock.calls.flatMap(([file, args]) =>
    file === 'bash' && Array.isArray(args) && typeof args[1] === 'string'
      ? [args[1]]
      : [],
  );
}

/** The `bash -lc` script body from the Corepack call, or undefined if absent. */
function corepackScript(): string | undefined {
  return bashScripts().find((script) => script.includes('corepack'));
}

describe('installMise', () => {
  beforeEach(() => {
    // resetAllMocks, not clearAllMocks: clearAllMocks leaves queued
    // mockResolvedValueOnce values in place, so an unconsumed value leaks into
    // the next test and fails it instead of the test that queued it.
    vi.resetAllMocks();
    mockReadFile.mockResolvedValue(
      'nodejs = "22"\npnpm = "10"\nuv = "latest"' as never,
    );
  });

  it('ensures ripgrep once mise is already available', async () => {
    // mise available → skip install; yarn --version ok → skip corepack;
    // python module available → skip install; then ripgrep checks.
    mockIsCommandAvailable.mockResolvedValueOnce(true); // mise
    mockExeca
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: '1.22.22',
        stderr: '',
      } as never) // yarn --version
      .mockResolvedValueOnce({
        exitCode: 0,
        stderr: '',
      } as never) // python module check
      .mockResolvedValueOnce({
        exitCode: 0,
        stderr: '',
      } as never); // rg --version

    await installMise(logger);

    expect(mockExeca).toHaveBeenCalledWith('yarn', ['--version'], {
      cwd: homedir(),
      reject: false,
      stdin: 'ignore',
      timeout: YARN_PROBE_TIMEOUT_MS,
    });
    expect(mockExeca).toHaveBeenCalledWith(
      'python',
      expect.any(Array),
      expect.objectContaining({
        reject: false,
        stdin: 'ignore',
      }),
    );
    expect(mockExeca).toHaveBeenCalledWith('rg', ['--version'], {
      reject: false,
      stdin: 'ignore',
    });
    expect(mockExeca).not.toHaveBeenCalledWith(
      'bash',
      ['-lc', 'curl -fsSL https://mise.run | sh'],
      expect.anything(),
    );
    expect(mockExeca).not.toHaveBeenCalledWith(
      'bash',
      ['-lc', COREPACK_YARN_ENABLE_SCRIPT],
      expect.anything(),
    );
  });

  it('enables corepack yarn when yarn is missing from PATH', async () => {
    mockIsCommandAvailable.mockResolvedValueOnce(true); // mise available
    mockExeca
      .mockResolvedValueOnce({
        exitCode: 1,
        stdout: '',
        stderr: 'yarn: not found',
      } as never) // yarn --version before enable
      .mockResolvedValueOnce({} as never) // corepack prepare + reshim
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: '1.22.22',
        stderr: '',
      } as never) // yarn --version after enable
      .mockResolvedValueOnce({
        exitCode: 0,
        stderr: '',
      } as never) // python module check
      .mockResolvedValueOnce({
        exitCode: 0,
        stderr: '',
      } as never); // rg --version

    await installMise(logger);

    expect(mockExeca).toHaveBeenCalledWith(
      'bash',
      ['-lc', COREPACK_YARN_ENABLE_SCRIPT],
      expect.objectContaining({
        cwd: homedir(),
        stdin: 'ignore',
        // Corepack downloads yarn from the registry inside the serial setup
        // block that gates task start, so it must not hang the sandbox boot.
        timeout: COREPACK_ENABLE_TIMEOUT_MS,
      }),
    );
    expect(logger.userLog.warn).not.toHaveBeenCalled();
  });

  it('scopes corepack enable to yarn so the mise-managed pnpm keeps winning', async () => {
    mockIsCommandAvailable.mockResolvedValueOnce(true); // mise available
    mockExeca
      .mockResolvedValueOnce({
        exitCode: 1,
        stdout: '',
        stderr: 'yarn: not found',
      } as never) // yarn --version before enable
      .mockResolvedValueOnce({} as never) // corepack enable + prepare + reshim
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: '1.22.22',
        stderr: '',
      } as never) // yarn --version after enable
      .mockResolvedValueOnce({ exitCode: 0, stderr: '' } as never) // python
      .mockResolvedValueOnce({ exitCode: 0, stderr: '' } as never); // rg

    await installMise(logger);

    // Anything other than `corepack enable yarn` — bare, or with pnpm appended
    // — writes pnpm/pnpx shims next to the corepack binary, which the reshim
    // then publishes ahead of the mise-managed pnpm.
    expect(corepackScript()).toBe(COREPACK_YARN_ENABLE_SCRIPT);
  });

  it('enables corepack yarn when yarn is missing entirely rather than failing', async () => {
    mockIsCommandAvailable.mockResolvedValueOnce(true); // mise available
    mockExeca
      // execa with reject:false reports a missing binary as exitCode undefined
      // (ENOENT), not exitCode 1 — this is the real sandbox shape.
      .mockResolvedValueOnce({
        exitCode: undefined,
        stdout: '',
        stderr: '',
        failed: true,
      } as never) // yarn --version before enable
      .mockResolvedValueOnce({} as never) // corepack enable + prepare + reshim
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: '1.22.22',
        stderr: '',
      } as never) // yarn --version after enable
      .mockResolvedValueOnce({ exitCode: 0, stderr: '' } as never) // python
      .mockResolvedValueOnce({ exitCode: 0, stderr: '' } as never); // rg

    await installMise(logger);

    expect(mockExeca).toHaveBeenCalledWith(
      'bash',
      ['-lc', COREPACK_YARN_ENABLE_SCRIPT],
      expect.objectContaining({ cwd: homedir() }),
    );
    expect(logger.userLog.warn).not.toHaveBeenCalled();
  });

  it('enables corepack yarn when the yarn probe itself throws', async () => {
    mockIsCommandAvailable.mockResolvedValueOnce(true); // mise available
    mockExeca
      .mockRejectedValueOnce(new Error('spawn yarn ENOENT') as never) // yarn --version
      .mockResolvedValueOnce({} as never) // corepack enable + prepare + reshim
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: '1.22.22',
        stderr: '',
      } as never) // yarn --version after enable
      .mockResolvedValueOnce({ exitCode: 0, stderr: '' } as never) // python
      .mockResolvedValueOnce({ exitCode: 0, stderr: '' } as never); // rg

    await installMise(logger);

    expect(mockExeca).toHaveBeenCalledWith(
      'bash',
      ['-lc', COREPACK_YARN_ENABLE_SCRIPT],
      expect.objectContaining({ cwd: homedir() }),
    );
  });

  it('warns when corepack enable fails', async () => {
    mockIsCommandAvailable.mockResolvedValueOnce(true); // mise
    mockExeca
      .mockResolvedValueOnce({
        exitCode: 1,
        stdout: '',
        stderr: '',
      } as never) // yarn --version missing
      .mockRejectedValueOnce(new Error('corepack: command not found') as never)
      .mockResolvedValueOnce({
        exitCode: 0,
        stderr: '',
      } as never) // python
      .mockResolvedValueOnce({
        exitCode: 0,
        stderr: '',
      } as never); // rg

    await installMise(logger);

    expect(logger.userLog.warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to enable corepack yarn'),
    );
  });

  it('warns when yarn remains non-executable after corepack enable', async () => {
    mockIsCommandAvailable.mockResolvedValueOnce(true); // mise
    mockExeca
      .mockResolvedValueOnce({
        exitCode: 1,
        stdout: '',
        stderr: '',
      } as never) // yarn before
      .mockResolvedValueOnce({} as never) // corepack enable succeeds
      .mockResolvedValueOnce({
        exitCode: 1,
        stdout: '',
        stderr: 'still broken',
      } as never) // yarn after still fails
      .mockResolvedValueOnce({
        exitCode: 0,
        stderr: '',
      } as never) // python
      .mockResolvedValueOnce({
        exitCode: 0,
        stderr: '',
      } as never); // rg

    await installMise(logger);

    expect(logger.userLog.warn).toHaveBeenCalledWith(
      'corepack enable completed but yarn is still not executable on PATH',
    );
  });

  it('enables corepack yarn only after node is installed', async () => {
    mockIsCommandAvailable
      .mockResolvedValueOnce(false) // mise missing
      .mockResolvedValueOnce(true) // mise after install
      .mockResolvedValueOnce(true); // uv for python package install
    mockReadFile.mockRejectedValueOnce(new Error('missing config') as never);
    mockExeca
      .mockResolvedValueOnce({} as never) // curl install mise
      .mockResolvedValueOnce({ exitCode: 0, stderr: '' } as never) // mise use nodejs
      .mockResolvedValueOnce({ exitCode: 0, stderr: '' } as never) // mise use pnpm
      .mockResolvedValueOnce({ exitCode: 0, stderr: '' } as never) // mise use uv
      .mockResolvedValueOnce({
        exitCode: 1,
        stdout: '',
        stderr: 'yarn: not found',
      } as never) // yarn --version before enable
      .mockResolvedValueOnce({} as never) // corepack enable + prepare + reshim
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: '1.22.22',
        stderr: '',
      } as never) // yarn --version after enable
      .mockResolvedValueOnce({ exitCode: 0, stderr: '' } as never) // python
      .mockResolvedValueOnce({ exitCode: 0, stderr: '' } as never); // rg

    await installMise(logger);

    // Corepack ships with node, so the node install has to land first.
    const scripts = bashScripts();
    const nodeInstallIndex = scripts.indexOf('mise use -g nodejs@22');
    const corepackIndex = scripts.findIndex((script) =>
      script.includes('corepack'),
    );

    expect(nodeInstallIndex).toBeGreaterThanOrEqual(0);
    expect(corepackIndex).toBeGreaterThan(nodeInstallIndex);
  });

  it('installs mise before ensuring ripgrep when mise is missing', async () => {
    mockIsCommandAvailable
      .mockResolvedValueOnce(false) // mise missing
      .mockResolvedValueOnce(true) // mise after install
      .mockResolvedValueOnce(true) // uv for python package install
      .mockResolvedValueOnce(true); // mise for ripgrep install
    mockReadFile.mockRejectedValueOnce(new Error('missing config') as never);
    mockExeca
      .mockResolvedValueOnce({} as never) // curl install mise
      .mockResolvedValueOnce({
        exitCode: 0,
        stderr: '',
      } as never) // mise use nodejs
      .mockResolvedValueOnce({
        exitCode: 0,
        stderr: '',
      } as never) // mise use pnpm
      .mockResolvedValueOnce({
        exitCode: 0,
        stderr: '',
      } as never) // mise use uv
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: '1.22.22',
        stderr: '',
      } as never) // yarn --version present (skip corepack)
      .mockResolvedValueOnce({
        exitCode: 1,
        stderr: '',
      } as never) // python -c import openai fails
      .mockResolvedValueOnce({} as never) // install openai package
      .mockResolvedValueOnce({
        exitCode: 1,
        stderr: '',
      } as never) // rg missing
      .mockResolvedValueOnce({
        exitCode: 0,
        stderr: '',
      } as never) // mise use ripgrep
      .mockResolvedValueOnce({
        exitCode: 0,
        stderr: '',
      } as never); // rg available after install

    await installMise(logger);

    expect(mockExeca).toHaveBeenCalledWith(
      'bash',
      ['-lc', 'curl -fsSL https://mise.run | sh'],
      {
        stdin: 'ignore',
      },
    );
    expect(mockExeca).toHaveBeenCalledWith(
      'bash',
      ['-lc', 'mise use -g nodejs@22'],
      {
        cwd: expect.any(String),
        stdin: 'ignore',
      },
    );
    expect(mockExeca).toHaveBeenCalledWith(
      'bash',
      ['-lc', 'mise use -g pnpm@10'],
      {
        cwd: expect.any(String),
        stdin: 'ignore',
      },
    );
    expect(mockExeca).toHaveBeenCalledWith(
      'bash',
      ['-lc', 'mise use -g uv@latest'],
      {
        cwd: expect.any(String),
        stdin: 'ignore',
      },
    );
    expect(mockExeca).toHaveBeenCalledWith(
      'bash',
      [
        '-lc',
        expect.stringContaining('--system --break-system-packages "$package"'),
        '_',
        'openai',
      ],
      {
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'pipe',
      },
    );
    expect(mockExeca).toHaveBeenCalledWith(
      'bash',
      ['-lc', `mise use -g ripgrep@${RIPGREP_VERSION}`],
      {
        reject: false,
        stdin: 'ignore',
      },
    );
  });

  it('configures uv in mise global config when it is missing', async () => {
    mockIsCommandAvailable.mockResolvedValue(true);
    mockReadFile.mockResolvedValueOnce('nodejs = "22"\npnpm = "10"' as never);
    mockExeca
      .mockResolvedValueOnce({} as never) // mise use uv
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: '1.22.22',
        stderr: '',
      } as never) // yarn --version
      .mockResolvedValueOnce({
        exitCode: 0,
        stderr: '',
      } as never) // python
      .mockResolvedValueOnce({
        exitCode: 0,
        stderr: '',
      } as never); // rg

    await installMise(logger);

    expect(mockExeca).toHaveBeenCalledWith(
      'bash',
      ['-lc', 'mise use -g uv@latest'],
      {
        cwd: expect.any(String),
        stdin: 'ignore',
      },
    );
    expect(mockExeca).toHaveBeenCalledWith('rg', ['--version'], {
      reject: false,
      stdin: 'ignore',
    });
  });

  it('configures nodejs in mise global config when it is missing', async () => {
    mockIsCommandAvailable.mockResolvedValue(true);
    mockReadFile.mockResolvedValueOnce('pnpm = "10"\nuv = "latest"' as never);
    mockExeca
      .mockResolvedValueOnce({} as never) // mise use nodejs
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: '1.22.22',
        stderr: '',
      } as never) // yarn --version
      .mockResolvedValueOnce({
        exitCode: 0,
        stderr: '',
      } as never) // python
      .mockResolvedValueOnce({
        exitCode: 0,
        stderr: '',
      } as never); // rg

    await installMise(logger);

    expect(mockExeca).toHaveBeenCalledWith(
      'bash',
      ['-lc', 'mise use -g nodejs@22'],
      {
        cwd: expect.any(String),
        stdin: 'ignore',
      },
    );
    expect(mockExeca).toHaveBeenCalledWith('rg', ['--version'], {
      reject: false,
      stdin: 'ignore',
    });
  });

  it('installs default Python packages when they are missing', async () => {
    mockIsCommandAvailable.mockResolvedValue(true);
    mockExeca
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: '1.22.22',
        stderr: '',
      } as never) // yarn --version
      .mockResolvedValueOnce({
        exitCode: 1,
        stderr: '',
      } as never) // python module missing
      .mockResolvedValueOnce({} as never) // install openai
      .mockResolvedValueOnce({
        exitCode: 0,
        stderr: '',
      } as never); // rg

    await installMise(logger);

    expect(mockExeca).toHaveBeenCalledWith(
      'bash',
      [
        '-lc',
        expect.stringContaining('--system --break-system-packages "$package"'),
        '_',
        'openai',
      ],
      {
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'pipe',
      },
    );
  });
});

describe('installRipgrep', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns immediately when ripgrep is already on PATH', async () => {
    mockExeca.mockResolvedValueOnce({
      exitCode: 0,
      stderr: '',
    } as never);

    await installRipgrep(logger);

    expect(mockIsCommandAvailable).not.toHaveBeenCalled();
    expect(mockExeca).toHaveBeenCalledTimes(1);
  });

  it('falls back to the ubi spec when the first mise install fails', async () => {
    mockExeca
      .mockResolvedValueOnce({
        exitCode: 1,
        stderr: '',
      } as never)
      .mockResolvedValueOnce({
        exitCode: 1,
        stderr: 'first attempt failed',
      } as never)
      .mockResolvedValueOnce({
        exitCode: 0,
        stderr: '',
      } as never)
      .mockResolvedValueOnce({
        exitCode: 0,
        stderr: '',
      } as never);
    mockIsCommandAvailable.mockResolvedValue(true);

    await installRipgrep(logger);

    expect(mockExeca).toHaveBeenCalledWith(
      'bash',
      ['-lc', `mise use -g ubi:BurntSushi/ripgrep@${RIPGREP_VERSION}`],
      {
        reject: false,
        stdin: 'ignore',
      },
    );
  });
});
