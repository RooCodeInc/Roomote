// pnpm exec dotenvx run -f .env.test -- pnpm --filter @roomote/worker exec vitest run src/workspace/__tests__/workspace-manager-clone.test.ts

import { existsSync } from 'fs';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { ExecutionError } from '../../command-executor';
import { WorkspaceManager } from '../workspace-manager';

vi.mock('@roomote/sdk/client', () => ({
  sdk: {
    repositories: {
      findRepository: vi.fn(),
      reportDefaultBranch: vi.fn(),
    },
  },
}));

const executeMock = vi.fn();
const executeAllMock = vi.fn();

vi.mock('../../command-executor', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../command-executor')>();

  return {
    ...actual,
    CommandExecutor: vi.fn().mockImplementation(function (cwd: string) {
      return {
        cwd,
        execute: executeMock,
        executeAll: executeAllMock,
      };
    }),
  };
});

const getGitHubTokenFileStatusMock = vi.fn();
const writeGitHubTokenFileMock = vi.fn();

vi.mock('../../lib/github-token', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../lib/github-token')>();

  return {
    ...actual,
    ensureGitCredentialHelper: vi.fn(() => '/tmp/credential-helper.sh'),
    getGitHubTokenFileStatus: () => getGitHubTokenFileStatusMock(),
    writeGitHubTokenFile: (token: string) => writeGitHubTokenFileMock(token),
  };
});

import { sdk } from '@roomote/sdk/client';

const REPO_FULL_NAME = 'acme/backend';

function stubTokenFile({ nonEmpty }: { nonEmpty: boolean }) {
  getGitHubTokenFileStatusMock.mockReturnValue({
    present: nonEmpty,
    nonEmpty,
  });
}

describe('WorkspaceManager repository clone preparation', () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    workspaceRoot = await mkdtemp(join(tmpdir(), 'workspace-clone-test-'));

    vi.mocked(sdk.repositories.findRepository).mockResolvedValue({
      id: 'repo-1',
      fullName: REPO_FULL_NAME,
      defaultBranch: 'main',
      cloneUrl: `https://github.com/${REPO_FULL_NAME}.git`,
    } as Awaited<ReturnType<typeof sdk.repositories.findRepository>>);
  });

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  function createManager(
    env: NodeJS.ProcessEnv = { PATH: '/usr/bin' },
    repositoryCloneTimeoutSeconds?: number,
  ) {
    const manager = new WorkspaceManager(workspaceRoot, env, false, undefined, {
      repositoryCloneTimeoutSeconds,
    });

    // Stub the post-clone steps that shell out or hit the network; these
    // tests only cover the credential fail-fast and clone/cleanup behavior.
    const internals = manager as unknown as {
      markGitSafeDirectory: () => Promise<void>;
      syncRepositoryGitState: () => Promise<void>;
      installToolVersions: () => Promise<void>;
    };
    internals.markGitSafeDirectory = vi.fn().mockResolvedValue(undefined);
    internals.syncRepositoryGitState = vi.fn().mockResolvedValue(undefined);
    internals.installToolVersions = vi.fn().mockResolvedValue(undefined);

    return manager;
  }

  async function createRepoDir({ withGitDir }: { withGitDir: boolean }) {
    const repoPath = join(workspaceRoot, REPO_FULL_NAME);
    await mkdir(withGitDir ? join(repoPath, '.git') : repoPath, {
      recursive: true,
    });
    await writeFile(join(repoPath, 'leftover.txt'), 'partial');
    return repoPath;
  }

  function mockCloneCreatesRepo() {
    executeMock.mockImplementation(async (command: { name: string }) => {
      if (command.name === 'Git clone') {
        await mkdir(join(workspaceRoot, REPO_FULL_NAME, '.git'), {
          recursive: true,
        });
      }
      return { success: true, stdout: '', stderr: '' };
    });
  }

  function getCloneCommand() {
    return executeMock.mock.calls
      .map(([command]) => command as { name: string; run: string })
      .find((command) => command.name === 'Git clone');
  }

  it('fails fast with an actionable error when a GitHub run has no credentials', async () => {
    stubTokenFile({ nonEmpty: false });
    const manager = createManager();

    await expect(
      manager.prepareRepository(REPO_FULL_NAME, 'main', undefined),
    ).rejects.toThrow(
      /No GitHub credentials are available for acme\/backend.*GitHub App/s,
    );

    expect(getCloneCommand()).toBeUndefined();
  });

  it('proceeds when the file-backed GitHub token is present', async () => {
    stubTokenFile({ nonEmpty: true });
    mockCloneCreatesRepo();
    const manager = createManager();

    await manager.prepareRepository(REPO_FULL_NAME, 'main', undefined);

    const clone = getCloneCommand();
    expect(clone).toBeDefined();
    expect(clone!.run).toBe(
      `rm -rf -- 'acme/backend' && git clone 'https://github.com/acme/backend.git' 'acme/backend'`,
    );
    expect(clone).toMatchObject({ timeout: 600 });
  });

  it('uses the deployment-configured clone timeout', async () => {
    stubTokenFile({ nonEmpty: true });
    mockCloneCreatesRepo();
    const manager = createManager({ PATH: '/usr/bin' }, 1_200);

    await manager.prepareRepository(REPO_FULL_NAME, 'main', undefined);

    expect(getCloneCommand()).toMatchObject({ timeout: 1_200 });
  });

  it('fails immediately with an actionable diagnostic when clone times out', async () => {
    stubTokenFile({ nonEmpty: true });
    executeMock.mockImplementation(async (command) => {
      if (command.name === 'Git clone') {
        throw new ExecutionError('Command timed out', {
          command,
          success: false,
          duration: 600_000,
          stderr: 'Receiving objects: 42% (420/1000)',
          error: 'Command timed out',
          timedOut: true,
        });
      }

      return { success: true, stdout: '', stderr: '' };
    });
    const manager = createManager({ PATH: '/usr/bin' }, 600);

    await expect(
      manager.prepareRepository(REPO_FULL_NAME, 'main', undefined),
    ).rejects.toThrow(
      /timed out after 600 seconds.*WORKER_REPOSITORY_CLONE_TIMEOUT_SECONDS/s,
    );

    expect(
      executeMock.mock.calls.filter(
        ([command]) => command.name === 'Git clone',
      ),
    ).toHaveLength(1);
  });

  it('retries transient clone failures with sanitized diagnostics', async () => {
    stubTokenFile({ nonEmpty: true });
    let cloneAttempts = 0;
    executeMock.mockImplementation(async (command) => {
      if (command.name === 'Git clone') {
        cloneAttempts += 1;
        if (cloneAttempts === 1) {
          throw new ExecutionError('Clone failed', {
            command,
            success: false,
            duration: 100,
            exitCode: 128,
            stderr:
              "fatal: unable to access 'https://token:secret@example.com/acme/backend.git'",
            error: 'Command failed with exit code 128',
          });
        }

        await mkdir(join(workspaceRoot, REPO_FULL_NAME, '.git'), {
          recursive: true,
        });
      }

      return { success: true, stdout: '', stderr: '' };
    });
    const manager = createManager();
    const sleepSpy = vi
      .spyOn(
        manager as unknown as { sleep: (ms: number) => Promise<void> },
        'sleep',
      )
      .mockResolvedValue(undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await manager.prepareRepository(REPO_FULL_NAME, 'main', undefined);

    expect(cloneAttempts).toBe(2);
    expect(sleepSpy).toHaveBeenCalledWith(2_000);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('https://[redacted]@example.com'),
    );
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('secret'));
  });

  it('materializes an env GH_TOKEN into the token file before cloning', async () => {
    stubTokenFile({ nonEmpty: false });
    mockCloneCreatesRepo();
    const manager = createManager({ PATH: '/usr/bin', GH_TOKEN: 'env-token' });

    await manager.prepareRepository(REPO_FULL_NAME, 'main', undefined);

    expect(writeGitHubTokenFileMock).toHaveBeenCalledWith('env-token');
    expect(getCloneCommand()).toBeDefined();
  });

  it('does not touch the token file when it already has a token', async () => {
    stubTokenFile({ nonEmpty: true });
    mockCloneCreatesRepo();
    const manager = createManager({ PATH: '/usr/bin', GH_TOKEN: 'env-token' });

    await manager.prepareRepository(REPO_FULL_NAME, 'main', undefined);

    expect(writeGitHubTokenFileMock).not.toHaveBeenCalled();
  });

  it('rejects repository names that resolve outside the workspace root', async () => {
    stubTokenFile({ nonEmpty: true });
    vi.mocked(sdk.repositories.findRepository).mockResolvedValue(undefined);
    const manager = createManager();

    await expect(
      manager.prepareRepository(
        '../../victim',
        'main',
        undefined,
        false,
        false,
        {
          sourceControlProvider: 'gitlab',
        },
      ),
    ).rejects.toThrow(/resolves outside the workspace root/);

    expect(getCloneCommand()).toBeUndefined();
  });

  it('rejects synced repository rows whose full name escapes the workspace', async () => {
    stubTokenFile({ nonEmpty: true });
    vi.mocked(sdk.repositories.findRepository).mockResolvedValue({
      id: 'repo-1',
      fullName: '../evil',
      defaultBranch: 'main',
      cloneUrl: 'https://github.com/acme/backend.git',
    } as Awaited<ReturnType<typeof sdk.repositories.findRepository>>);
    const manager = createManager();

    await expect(
      manager.prepareRepository(REPO_FULL_NAME, 'main', undefined),
    ).rejects.toThrow(/resolves outside the workspace root/);

    expect(getCloneCommand()).toBeUndefined();
  });

  it('removes an existing directory without .git and clones again', async () => {
    stubTokenFile({ nonEmpty: true });
    mockCloneCreatesRepo();
    const repoPath = await createRepoDir({ withGitDir: false });
    const manager = createManager();

    await manager.prepareRepository(REPO_FULL_NAME, 'main', undefined);

    expect(getCloneCommand()).toBeDefined();
    expect(existsSync(join(repoPath, 'leftover.txt'))).toBe(false);
    expect(existsSync(join(repoPath, '.git'))).toBe(true);
  });

  it('keeps an existing valid clone and skips cloning', async () => {
    stubTokenFile({ nonEmpty: true });
    executeMock.mockResolvedValue({ success: true, stdout: '', stderr: '' });
    const repoPath = await createRepoDir({ withGitDir: true });
    const manager = createManager();

    await manager.prepareRepository(REPO_FULL_NAME, 'main', undefined);

    expect(getCloneCommand()).toBeUndefined();
    expect(existsSync(join(repoPath, 'leftover.txt'))).toBe(true);
  });

  it('skips the credential check when preserving git state of an existing clone', async () => {
    stubTokenFile({ nonEmpty: false });
    executeMock.mockResolvedValue({ success: true, stdout: '', stderr: '' });
    await createRepoDir({ withGitDir: true });
    const manager = createManager();

    await expect(
      manager.prepareRepository(REPO_FULL_NAME, 'main', undefined, true),
    ).resolves.toBeDefined();
  });

  it('does not run the GitHub credential check for other providers', async () => {
    stubTokenFile({ nonEmpty: false });
    mockCloneCreatesRepo();
    const manager = createManager();

    await manager.prepareRepository(
      REPO_FULL_NAME,
      'main',
      undefined,
      false,
      false,
      { sourceControlProvider: 'gitlab' },
    );

    expect(getGitHubTokenFileStatusMock).not.toHaveBeenCalled();
    expect(getCloneCommand()).toBeDefined();
  });
});
