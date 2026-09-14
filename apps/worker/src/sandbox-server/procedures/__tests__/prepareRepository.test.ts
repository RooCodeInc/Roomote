import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { RunTokenContext } from '@roomote/types';

import { WorkspaceManager } from '../../../workspace';
import { appRouter } from '../../routers';
import type { Context } from '../../trpc';

const { mockFindRepository, mockListRepositories, workspaceRootRef } =
  vi.hoisted(() => ({
    mockFindRepository: vi.fn(),
    mockListRepositories: vi.fn(),
    workspaceRootRef: { current: '' },
  }));

vi.mock('@roomote/sdk/client', () => ({
  sdk: {
    repositories: {
      findRepository: mockFindRepository,
      listRepositories: mockListRepositories,
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

describe('prepareRepository procedure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    workspaceRootRef.current = fs.mkdtempSync(
      path.join(os.tmpdir(), 'prepare-repository-'),
    );
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

    expect(mockFindRepository).toHaveBeenCalledWith({ fullName: 'acme/api' });
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
    const manifest = fs.readFileSync(result.manifestPath, 'utf8');
    expect(manifest).toContain(
      '2 repositories are available to this task; 1 is checked out.',
    );
    expect(manifest).toContain(
      `| \`acme/api\` | yes (\`${result.repositoryPath}\`) |`,
    );
  });

  it('passes the branch and a non-default provider through', async () => {
    mockFindRepository.mockResolvedValue({
      ...apiRepository,
      fullName: 'acme/gitlab-app',
      sourceControlProvider: 'gitlab',
    });
    const prepareSpy = vi
      .spyOn(WorkspaceManager.prototype, 'prepareRepository')
      .mockResolvedValue(
        path.join(workspaceRootRef.current, 'acme', 'gitlab-app'),
      );

    await createCaller().commands.prepareRepository({
      repositoryFullName: 'acme/gitlab-app',
      branch: 'release',
    });

    expect(prepareSpy).toHaveBeenCalledWith(
      'acme/gitlab-app',
      'release',
      undefined,
      false,
      false,
      { sourceControlProvider: 'gitlab' },
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
