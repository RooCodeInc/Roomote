// pnpm exec dotenvx run -f .env.test -- pnpm --filter @roomote/worker exec vitest run src/workspace/__tests__/workspace-manager-sync.test.ts

import { ExecutionError } from '../../command-executor';
import { WorkspaceManager } from '../workspace-manager';
import { COMMAND_DEFAULT_TIMEOUT } from '@roomote/types';

const RESET_LOCAL_CHANGES_COMMAND =
  'if git rev-parse --verify HEAD >/dev/null 2>&1; then git reset --hard HEAD; fi';

vi.mock('@roomote/sdk/client', () => ({
  sdk: {
    repositories: {
      findRepository: vi.fn(),
    },
  },
}));

const GIT_FETCH_COMMAND = {
  name: 'Git fetch',
  run: 'git fetch --all --tags --prune --force',
  timeout: 300,
  continue_on_error: false,
} as const;

const GIT_RESOLVE_LOCAL_ORIGIN_HEAD_COMMAND = {
  name: 'Git resolve local origin/HEAD',
  run: 'git symbolic-ref --quiet --short refs/remotes/origin/HEAD',
  timeout: 60,
  continue_on_error: true,
} as const;

const GIT_RESOLVE_REMOTE_HEAD_COMMAND = {
  name: 'Git resolve remote HEAD',
  run: 'git ls-remote --symref origin HEAD',
  timeout: 60,
  retries: 1,
  continue_on_error: true,
} as const;

function buildVerifyRemoteBranchCommand(branch: string) {
  return {
    name: 'Git verify remote branch',
    run: `git show-ref --verify --quiet 'refs/remotes/origin/${branch}'`,
    timeout: 60,
    continue_on_error: true,
  };
}

function buildCheckoutCommands(branch: string) {
  return [
    {
      name: 'Git reset local changes',
      run: RESET_LOCAL_CHANGES_COMMAND,
      timeout: COMMAND_DEFAULT_TIMEOUT,
      continue_on_error: false,
    },
    {
      name: 'Git clean untracked',
      run: 'git clean -fd',
      timeout: COMMAND_DEFAULT_TIMEOUT,
      continue_on_error: false,
    },
    {
      name: 'Git checkout branch',
      run: `git checkout -B '${branch}' 'origin/${branch}'`,
      timeout: COMMAND_DEFAULT_TIMEOUT,
      continue_on_error: false,
    },
    {
      name: 'Git reset to remote',
      run: `git reset --hard 'origin/${branch}'`,
      timeout: COMMAND_DEFAULT_TIMEOUT,
      continue_on_error: false,
    },
  ];
}

function makeFetchError(
  stderr = "fatal: unable to access 'https://github.com/acme/backend.git/': Connection reset by peer",
) {
  return new ExecutionError('Command failed with exit code 128', {
    command: GIT_FETCH_COMMAND,
    success: false,
    duration: 5,
    exitCode: 128,
    stdout: '',
    stderr,
    error: 'Command failed with exit code 128',
  });
}

function makeRepositoryNotFoundFetchError() {
  return makeFetchError(
    "remote: Repository not found.\nfatal: repository 'https://github.com/acme/backend.git/' not found",
  );
}

type TestExecutor = {
  execute: ReturnType<typeof vi.fn>;
  executeAll: ReturnType<typeof vi.fn>;
};

type PrivateWorkspaceManagerMethods = {
  sleep: ReturnType<typeof vi.fn>;
  syncRepositoryGitState: (args: {
    executor: TestExecutor;
    repoFullName: string;
    targetBranch: string;
    sha?: string;
    allowRemoteHeadFallback: boolean;
    setDefaultRemote: boolean;
  }) => Promise<void>;
};

describe('WorkspaceManager git synchronization', () => {
  let manager: WorkspaceManager;
  let privateManager: PrivateWorkspaceManagerMethods;
  let syncRepositoryGitState: PrivateWorkspaceManagerMethods['syncRepositoryGitState'];
  let executor: TestExecutor;
  let sleepSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    manager = new WorkspaceManager('/workspace', {} as NodeJS.ProcessEnv);
    privateManager = manager as unknown as PrivateWorkspaceManagerMethods;
    syncRepositoryGitState =
      privateManager.syncRepositoryGitState.bind(manager);
    executor = {
      execute: vi.fn(),
      executeAll: vi.fn().mockResolvedValue([]),
    };

    sleepSpy = vi.spyOn(privateManager, 'sleep').mockResolvedValue(undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('retries git fetch once before continuing with the remaining sync commands', async () => {
    executor.execute
      .mockRejectedValueOnce(makeFetchError())
      .mockResolvedValueOnce({
        command: GIT_FETCH_COMMAND,
        success: true,
        duration: 5,
        stdout: '',
        stderr: '',
      });

    await syncRepositoryGitState({
      executor,
      repoFullName: 'acme/backend',
      targetBranch: 'main',
      allowRemoteHeadFallback: false,
      setDefaultRemote: false,
    });

    expect(executor.execute).toHaveBeenCalledTimes(2);
    expect(executor.execute).toHaveBeenNthCalledWith(1, GIT_FETCH_COMMAND);
    expect(executor.execute).toHaveBeenNthCalledWith(2, GIT_FETCH_COMMAND);
    expect(sleepSpy).toHaveBeenCalledWith(2000);

    expect(executor.executeAll).toHaveBeenCalledWith(
      buildCheckoutCommands('main'),
    );
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('Git fetch attempt 1/5 failed for acme/backend'),
    );
  });

  it('continues with branch checkout commands when the repo has no valid HEAD yet', async () => {
    await syncRepositoryGitState({
      executor,
      repoFullName: 'acme/backend',
      targetBranch: 'main',
      allowRemoteHeadFallback: false,
      setDefaultRemote: false,
    });

    expect(executor.execute).toHaveBeenCalledTimes(1);
    expect(executor.execute).toHaveBeenCalledWith(GIT_FETCH_COMMAND);
    expect(executor.executeAll).toHaveBeenCalledWith(
      buildCheckoutCommands('main'),
    );
  });

  it('retries repository not found failures as token propagation delays before succeeding', async () => {
    executor.execute
      .mockRejectedValueOnce(makeRepositoryNotFoundFetchError())
      .mockRejectedValueOnce(makeRepositoryNotFoundFetchError())
      .mockResolvedValueOnce({
        command: GIT_FETCH_COMMAND,
        success: true,
        duration: 5,
        stdout: '',
        stderr: '',
      });

    await syncRepositoryGitState({
      executor,
      repoFullName: 'acme/backend',
      targetBranch: 'main',
      allowRemoteHeadFallback: false,
      setDefaultRemote: false,
    });

    expect(executor.execute).toHaveBeenCalledTimes(3);
    expect(sleepSpy).toHaveBeenNthCalledWith(1, 2000);
    expect(sleepSpy).toHaveBeenNthCalledWith(2, 4000);
    expect(console.warn).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining(
        'Likely a GitHub App token propagation delay rather than a missing repository',
      ),
    );
    expect(console.warn).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('Git fetch attempt 2/5 failed for acme/backend'),
    );
  });

  it('rethrows the final fetch error after exhausting retries', async () => {
    const fetchError = makeFetchError();
    executor.execute.mockRejectedValue(fetchError);

    await expect(
      syncRepositoryGitState({
        executor,
        repoFullName: 'acme/backend',
        targetBranch: 'main',
        allowRemoteHeadFallback: false,
        setDefaultRemote: false,
      }),
    ).rejects.toBe(fetchError);

    expect(executor.execute).toHaveBeenCalledTimes(5);
    expect(sleepSpy).toHaveBeenNthCalledWith(1, 2000);
    expect(sleepSpy).toHaveBeenNthCalledWith(2, 4000);
    expect(sleepSpy).toHaveBeenNthCalledWith(3, 8000);
    expect(sleepSpy).toHaveBeenNthCalledWith(4, 16000);
    expect(executor.executeAll).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledTimes(4);
  });

  it('uses local origin/HEAD before a network lookup when stored default metadata is stale', async () => {
    executor.execute
      .mockResolvedValueOnce({
        command: GIT_FETCH_COMMAND,
        success: true,
        duration: 5,
        stdout: '',
        stderr: '',
      })
      .mockResolvedValueOnce({
        command: GIT_RESOLVE_LOCAL_ORIGIN_HEAD_COMMAND,
        success: true,
        duration: 5,
        stdout: 'origin/develop\n',
        stderr: '',
      })
      .mockResolvedValueOnce({
        command: buildVerifyRemoteBranchCommand('develop'),
        success: true,
        duration: 5,
        stdout: '',
        stderr: '',
      });

    await syncRepositoryGitState({
      executor,
      repoFullName: 'acme/backend',
      targetBranch: 'main',
      allowRemoteHeadFallback: true,
      setDefaultRemote: false,
    });

    expect(executor.execute).toHaveBeenCalledTimes(3);
    expect(executor.execute).not.toHaveBeenCalledWith(
      GIT_RESOLVE_REMOTE_HEAD_COMMAND,
    );
    expect(executor.executeAll).toHaveBeenCalledWith(
      buildCheckoutCommands('develop'),
    );
    expect(console.warn).toHaveBeenCalledWith(
      'Resolved origin/HEAD for acme/backend to develop; ignoring stale default branch main.',
    );
  });

  it('uses the remote HEAD when the local origin/HEAD ref is unavailable', async () => {
    executor.execute
      .mockResolvedValueOnce({
        command: GIT_FETCH_COMMAND,
        success: true,
        duration: 5,
        stdout: '',
        stderr: '',
      })
      .mockResolvedValueOnce({
        command: GIT_RESOLVE_LOCAL_ORIGIN_HEAD_COMMAND,
        success: false,
        duration: 5,
        stdout: '',
        stderr: 'fatal: ref refs/remotes/origin/HEAD is not a symbolic ref',
      })
      .mockResolvedValueOnce({
        command: GIT_RESOLVE_REMOTE_HEAD_COMMAND,
        success: true,
        duration: 5,
        stdout:
          'ref: refs/heads/master\tHEAD\n0123456789abcdef0123456789abcdef01234567\tHEAD\n',
        stderr: '',
      })
      .mockResolvedValueOnce({
        command: buildVerifyRemoteBranchCommand('master'),
        success: true,
        duration: 5,
        stdout: '',
        stderr: '',
      });

    await syncRepositoryGitState({
      executor,
      repoFullName: 'acme/backend',
      targetBranch: 'main',
      allowRemoteHeadFallback: true,
      setDefaultRemote: false,
    });

    expect(executor.executeAll).toHaveBeenCalledWith(
      buildCheckoutCommands('master'),
    );
  });

  it('uses a verified stored default when both origin/HEAD lookups are unavailable', async () => {
    executor.execute
      .mockResolvedValueOnce({ success: true, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ success: false, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ success: false, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ success: true, stdout: '', stderr: '' });

    await syncRepositoryGitState({
      executor,
      repoFullName: 'acme/backend',
      targetBranch: 'main',
      allowRemoteHeadFallback: true,
      setDefaultRemote: false,
    });

    expect(executor.execute).toHaveBeenLastCalledWith(
      buildVerifyRemoteBranchCommand('main'),
    );
    expect(executor.executeAll).toHaveBeenCalledWith(
      buildCheckoutCommands('main'),
    );
  });

  it('fails before checkout when origin/HEAD is unavailable and the stored default does not exist', async () => {
    executor.execute
      .mockResolvedValueOnce({ success: true, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ success: false, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ success: false, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ success: false, stdout: '', stderr: '' });

    await expect(
      syncRepositoryGitState({
        executor,
        repoFullName: 'acme/backend',
        targetBranch: 'main',
        allowRemoteHeadFallback: true,
        setDefaultRemote: false,
      }),
    ).rejects.toThrow(
      'Could not determine the default branch for acme/backend: origin/HEAD was unavailable and stored branch origin/main does not exist.',
    );

    expect(executor.executeAll).not.toHaveBeenCalled();
  });

  it('keeps the longer sync timeout while still pinning repositories to an exact sha', async () => {
    await syncRepositoryGitState({
      executor,
      repoFullName: 'acme/backend',
      targetBranch: 'main',
      sha: '0123456789abcdef0123456789abcdef01234567',
      allowRemoteHeadFallback: false,
      setDefaultRemote: false,
    });

    expect(executor.executeAll).toHaveBeenCalledWith([
      ...buildCheckoutCommands('main'),
      {
        name: 'Git pin to sha',
        run: "git reset --hard '0123456789abcdef0123456789abcdef01234567'",
        timeout: COMMAND_DEFAULT_TIMEOUT,
        continue_on_error: false,
      },
    ]);
  });
});
