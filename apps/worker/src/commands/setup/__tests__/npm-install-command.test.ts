import { execa } from 'execa';

const { mockExeca } = vi.hoisted(() => ({
  mockExeca: vi.fn(),
}));

vi.mock('execa', () => ({
  execa: mockExeca,
}));

import { resolveNpmInstallCommand } from '../npm-install-command';

const MISE_NPM_PATH = '/opt/mise/installs/node/22.17.1/bin/npm';

function versionResult(output: string) {
  return {
    exitCode: 0,
    stdout: output,
    stderr: '',
  } as Awaited<ReturnType<typeof execa>>;
}

describe('resolveNpmInstallCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses the mise-managed npm when it is already available', async () => {
    mockExeca.mockResolvedValueOnce(versionResult(MISE_NPM_PATH));

    await expect(resolveNpmInstallCommand()).resolves.toEqual({
      command: MISE_NPM_PATH,
      argsPrefix: [],
    });

    expect(mockExeca).toHaveBeenCalledWith('bash', ['-lc', 'mise which npm'], {
      reject: false,
      stdin: 'ignore',
    });
  });

  it('falls back to the PATH npm shim when it is healthy', async () => {
    mockExeca
      .mockRejectedValueOnce(new Error('spawn mise ENOENT'))
      .mockResolvedValueOnce(versionResult('10.9.2'));

    await expect(resolveNpmInstallCommand()).resolves.toEqual({
      command: 'npm',
      argsPrefix: [],
    });

    expect(mockExeca).toHaveBeenNthCalledWith(2, 'npm', ['--version'], {
      reject: false,
      stdin: 'ignore',
    });
  });

  it('repairs npm via mise when npm is not yet available from mise', async () => {
    mockExeca
      .mockResolvedValueOnce({
        exitCode: 1,
        stdout: '',
        stderr: 'npm not installed in mise',
      } as Awaited<ReturnType<typeof execa>>)
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: MISE_NPM_PATH,
        stderr: '',
      } as Awaited<ReturnType<typeof execa>>);

    await expect(resolveNpmInstallCommand()).resolves.toEqual({
      command: MISE_NPM_PATH,
      argsPrefix: [],
    });

    expect(mockExeca).toHaveBeenNthCalledWith(
      2,
      'bash',
      ['-lc', 'mise use -g nodejs@22 >/dev/null 2>&1 && mise which npm'],
      {
        reject: false,
        stdin: 'ignore',
      },
    );
  });

  it('throws when neither mise nor PATH can provide a healthy npm', async () => {
    mockExeca
      .mockRejectedValueOnce(new Error('spawn mise ENOENT'))
      .mockRejectedValueOnce(new Error('spawn npm ENOENT'));

    await expect(resolveNpmInstallCommand()).rejects.toThrow(
      'Unable to resolve a healthy npm install command from mise or PATH',
    );
  });
});
