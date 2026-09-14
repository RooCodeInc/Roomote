import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { RunTokenContext } from '@roomote/types';

import {
  engageCredentialWriteBarrier,
  resetCredentialWriteBarrierForTesting,
} from '../../../lib/credential-write-barrier';
import { WorkspaceManager } from '../../../workspace';
import { appRouter } from '../../routers';
import type { Context } from '../../trpc';

const {
  mockFindRepository,
  mockListRepositories,
  mockFindFirstById,
  workspaceRootRef,
} = vi.hoisted(() => ({
  mockFindRepository: vi.fn(),
  mockListRepositories: vi.fn(),
  mockFindFirstById: vi.fn(),
  workspaceRootRef: { current: '' },
}));

vi.mock('@roomote/sdk/client', () => ({
  sdk: {
    repositories: {
      findRepository: mockFindRepository,
      listRepositories: mockListRepositories,
    },
    taskRuns: {
      findFirstById: mockFindFirstById,
    },
  },
}));

vi.mock('../../../commands/setup/workspace/shared', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../../commands/setup/workspace/shared')
    >();

  return {
    ...actual,
    createWorkspaceManager: (
      envVars: Record<string, string | undefined>,
    ): ReturnType<typeof actual.createWorkspaceManager> => ({
      workspaceRoot: workspaceRootRef.current,
      workspaceManager: new WorkspaceManager(
        workspaceRootRef.current,
        envVars,
        false,
      ),
    }),
  };
});

function createCaller(runtimeEnv: Record<string, string> = {}) {
  const ctx = {
    workingDirectory: workspaceRootRef.current,
    harness: { isConnected: true },
    auth: {
      runId: 1,
      userId: 'user-1',
      principal: 'user',
      tokenType: 'run',
      version: 1,
    } satisfies RunTokenContext,
    runId: 1,
    taskRuntime: { homeDir: '/home/testuser', runtimeEnv },
  } as unknown as Context;

  return appRouter.createCaller(ctx);
}

const apiRepository = {
  id: 'repo-1',
  fullName: 'acme/api',
  sourceControlProvider: 'github',
  defaultBranch: 'main',
  description: 'REST API',
  private: false,
};

const gitlabRepository = {
  ...apiRepository,
  id: 'repo-3',
  fullName: 'acme/gitlab-app',
  sourceControlProvider: 'gitlab',
};

function stubTaskRun(payload: Record<string, unknown>) {
  mockFindFirstById.mockResolvedValue({ id: 1, taskId: 'task-1', payload });
}

describe('prepareRepository procedure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    resetCredentialWriteBarrierForTesting();
    workspaceRootRef.current = fs.mkdtempSync(
      path.join(os.tmpdir(), 'prepare-repository-'),
    );
    stubTaskRun({
      repo: '__all_repositories__',
      sourceControlProvider: 'github',
    });
    mockListRepositories.mockResolvedValue([
      apiRepository,
      { ...apiRepository, id: 'repo-2', fullName: 'acme/web' },
    ]);
  });

  it('clones the repository into the workspace and refreshes the manifest', async () => {
    mockFindRepository.mockResolvedValue(apiRepository);
    const prepareSpy = vi
      .spyOn(WorkspaceManager.prototype, 'prepareRepository')
      .mockImplementation(async (fullName) => {
        const repoPath = path.join(workspaceRootRef.current, fullName);
        fs.mkdirSync(path.join(repoPath, '.git'), { recursive: true });
        return repoPath;
      });

    const result = await createCaller({
      HOME: '/home/testuser',
    }).commands.prepareRepository({ repositoryFullName: 'acme/api' });

    expect(mockFindFirstById).toHaveBeenCalledWith(1);
    expect(mockFindRepository).toHaveBeenCalledWith({
      fullName: 'acme/api',
      sourceControlProvider: 'github',
    });
    expect(prepareSpy).toHaveBeenCalledWith(
      'acme/api',
      undefined,
      undefined,
      false,
      false,
      {},
    );
    expect(result).toEqual({
      success: true,
      repositoryFullName: 'acme/api',
      repositoryPath: path.join(workspaceRootRef.current, 'acme', 'api'),
      alreadyCheckedOut: false,
      manifestPath: path.join(workspaceRootRef.current, 'REPOSITORIES.md'),
    });
    expect(mockListRepositories).toHaveBeenCalledWith({
      sourceControlProvider: 'github',
    });
    const manifest = fs.readFileSync(result.manifestPath, 'utf8');
    expect(manifest).toContain(
      '2 repositories are available to this task; 1 is checked out.',
    );
    expect(manifest).toContain(
      `| \`acme/api\` | yes (\`${result.repositoryPath}\`) |`,
    );
  });

  it('resolves the provider from the stamped repository map and keeps mixed providers in the manifest', async () => {
    stubTaskRun({
      repo: '__all_repositories__',
      sourceControlProvider: 'github',
      repositoryProviders: {
        'acme/api': 'github',
        'acme/gitlab-app': 'gitlab',
      },
    });
    mockFindRepository.mockResolvedValue(gitlabRepository);
    mockListRepositories.mockResolvedValue([apiRepository, gitlabRepository]);
    const prepareSpy = vi
      .spyOn(WorkspaceManager.prototype, 'prepareRepository')
      .mockImplementation(async (fullName) => {
        const repoPath = path.join(workspaceRootRef.current, fullName);
        fs.mkdirSync(path.join(repoPath, '.git'), { recursive: true });
        return repoPath;
      });

    const result = await createCaller().commands.prepareRepository({
      repositoryFullName: 'ACME/GitLab-App',
      branch: 'release',
    });

    expect(mockFindRepository).toHaveBeenCalledWith({
      fullName: 'acme/gitlab-app',
      sourceControlProvider: 'gitlab',
    });
    expect(prepareSpy).toHaveBeenCalledWith(
      'acme/gitlab-app',
      'release',
      undefined,
      false,
      false,
      { sourceControlProvider: 'gitlab' },
    );
    // The refresh lists every provider so the GitHub rows survive.
    expect(mockListRepositories).toHaveBeenCalledWith({});
    const manifest = fs.readFileSync(result.manifestPath, 'utf8');
    expect(manifest).toContain('| `acme/api` | no |');
    expect(manifest).toContain('| `acme/gitlab-app` | yes (');
  });

  it('rejects repositories outside the stamped repository set before touching git', async () => {
    stubTaskRun({
      repo: '__all_repositories__',
      sourceControlProvider: 'gitlab',
      repositoryProviders: { 'acme/gitlab-app': 'gitlab' },
    });
    const prepareSpy = vi.spyOn(
      WorkspaceManager.prototype,
      'prepareRepository',
    );

    await expect(
      createCaller().commands.prepareRepository({
        repositoryFullName: 'acme/other',
      }),
    ).rejects.toThrow(
      "Repository 'acme/other' is not part of this task's repository set",
    );
    expect(mockFindRepository).not.toHaveBeenCalled();
    expect(prepareSpy).not.toHaveBeenCalled();
  });

  it.each([
    [
      'single-repository',
      { repo: 'acme/api', sourceControlProvider: 'github' },
    ],
    [
      'repository-set',
      {
        repo: '__all_repositories__',
        selectedRepositories: ['acme/api'],
        sourceControlProvider: 'github',
      },
    ],
    ['environment', { environmentId: 'env-1', repo: 'acme/api' }],
  ])(
    'refuses to widen a %s workspace with another deployment repository',
    async (_label, payload) => {
      stubTaskRun(payload);
      const prepareSpy = vi.spyOn(
        WorkspaceManager.prototype,
        'prepareRepository',
      );

      await expect(
        createCaller().commands.prepareRepository({
          repositoryFullName: 'acme/web',
        }),
      ).rejects.toThrow(
        'Repository checkout on demand is only available in all-repositories and Blank slate workspaces',
      );
      expect(mockFindRepository).not.toHaveBeenCalled();
      expect(prepareSpy).not.toHaveBeenCalled();
    },
  );

  it('refuses a Blank slate run launched without a repository stamp', async () => {
    stubTaskRun({ repo: '__no_repositories__' });
    const prepareSpy = vi.spyOn(
      WorkspaceManager.prototype,
      'prepareRepository',
    );

    await expect(
      createCaller().commands.prepareRepository({
        repositoryFullName: 'acme/web',
      }),
    ).rejects.toThrow(
      'this Blank slate run was launched without connected source control',
    );
    expect(mockFindRepository).not.toHaveBeenCalled();
    expect(prepareSpy).not.toHaveBeenCalled();
  });

  it('checks a stamped deployment repository out for a Blank slate run', async () => {
    stubTaskRun({
      repo: '__no_repositories__',
      sourceControlProvider: 'github',
      repositoryProviders: { 'acme/api': 'github', 'acme/web': 'github' },
    });
    mockFindRepository.mockResolvedValue(apiRepository);
    const prepareSpy = vi
      .spyOn(WorkspaceManager.prototype, 'prepareRepository')
      .mockImplementation(async (fullName) => {
        const repoPath = path.join(workspaceRootRef.current, fullName);
        fs.mkdirSync(path.join(repoPath, '.git'), { recursive: true });
        return repoPath;
      });

    const result = await createCaller().commands.prepareRepository({
      repositoryFullName: 'acme/api',
    });

    expect(prepareSpy).toHaveBeenCalledWith(
      'acme/api',
      undefined,
      undefined,
      false,
      false,
      {},
    );
    expect(result).toMatchObject({
      success: true,
      repositoryFullName: 'acme/api',
      repositoryPath: path.join(workspaceRootRef.current, 'acme', 'api'),
      alreadyCheckedOut: false,
    });
    expect(fs.readFileSync(result.manifestPath, 'utf8')).toContain(
      `| \`acme/api\` | yes (\`${result.repositoryPath}\`) |`,
    );
  });

  it('leaves an existing checkout untouched', async () => {
    mockFindRepository.mockResolvedValue(apiRepository);
    const repoPath = path.join(workspaceRootRef.current, 'acme', 'api');
    fs.mkdirSync(path.join(repoPath, '.git'), { recursive: true });
    const prepareSpy = vi.spyOn(
      WorkspaceManager.prototype,
      'prepareRepository',
    );

    const result = await createCaller().commands.prepareRepository({
      repositoryFullName: 'acme/api',
    });

    expect(prepareSpy).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: true,
      repositoryPath: repoPath,
      alreadyCheckedOut: true,
    });
  });

  it('rejects repositories that are not active in the deployment', async () => {
    mockFindRepository.mockResolvedValue(undefined);
    const prepareSpy = vi.spyOn(
      WorkspaceManager.prototype,
      'prepareRepository',
    );

    await expect(
      createCaller().commands.prepareRepository({
        repositoryFullName: 'acme/missing',
      }),
    ).rejects.toThrow(
      "Repository 'acme/missing' is not an active repository of this deployment",
    );
    expect(prepareSpy).not.toHaveBeenCalled();
  });

  it('refuses to clone while the pre-snapshot credential barrier is engaged', async () => {
    await engageCredentialWriteBarrier();
    const prepareSpy = vi.spyOn(
      WorkspaceManager.prototype,
      'prepareRepository',
    );

    await expect(
      createCaller().commands.prepareRepository({
        repositoryFullName: 'acme/api',
      }),
    ).rejects.toThrow(
      'Repository checkout is unavailable while the sandbox prepares for a snapshot',
    );
    expect(mockFindFirstById).not.toHaveBeenCalled();
    expect(prepareSpy).not.toHaveBeenCalled();
  });

  it('coalesces concurrent calls for the same repository into one clone', async () => {
    mockFindRepository.mockResolvedValue(apiRepository);
    let resolveClone: ((value: string) => void) | undefined;
    const prepareSpy = vi
      .spyOn(WorkspaceManager.prototype, 'prepareRepository')
      .mockImplementation(
        () =>
          new Promise<string>((resolve) => {
            resolveClone = resolve;
          }),
      );
    const caller = createCaller();

    const first = caller.commands.prepareRepository({
      repositoryFullName: 'acme/api',
    });
    const second = caller.commands.prepareRepository({
      repositoryFullName: 'ACME/api',
    });
    await vi.waitFor(() => expect(resolveClone).toBeDefined());
    resolveClone?.(path.join(workspaceRootRef.current, 'acme', 'api'));

    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(prepareSpy).toHaveBeenCalledTimes(1);
    expect(firstResult.repositoryPath).toBe(secondResult.repositoryPath);
  });
});
