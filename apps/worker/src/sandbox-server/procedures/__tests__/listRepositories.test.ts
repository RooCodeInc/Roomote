import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { RunTokenContext } from '@roomote/types';

import { WorkspaceManager } from '../../../workspace';
import { appRouter } from '../../routers';
import type { Context } from '../../trpc';

const { mockListRepositories, mockFindFirstById, workspaceRootRef } =
  vi.hoisted(() => ({
    mockListRepositories: vi.fn(),
    mockFindFirstById: vi.fn(),
    workspaceRootRef: { current: '' },
  }));

vi.mock('@roomote/sdk/client', () => ({
  sdk: {
    repositories: { listRepositories: mockListRepositories },
    taskRuns: { findFirstById: mockFindFirstById },
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

function createCaller({ runId = 1 as number | undefined, hasRun = true } = {}) {
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
    runId: hasRun ? runId : undefined,
    taskRuntime: { homeDir: '/home/testuser', runtimeEnv: {} },
  } as unknown as Context;

  return appRouter.createCaller(ctx);
}

function stubTaskRun(payload: Record<string, unknown>) {
  mockFindFirstById.mockResolvedValue({ id: 1, taskId: 'task-1', payload });
}

const repository = (fullName: string, overrides = {}) => ({
  id: fullName,
  fullName,
  sourceControlProvider: 'github',
  defaultBranch: 'main',
  description: null,
  private: false,
  ...overrides,
});

describe('listRepositories procedure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workspaceRootRef.current = fs.mkdtempSync(
      path.join(os.tmpdir(), 'list-repositories-'),
    );
    stubTaskRun({
      repo: '__all_repositories__',
      sourceControlProvider: 'github',
    });
    mockListRepositories.mockResolvedValue([
      repository('octo/widgets', {
        description: '  Widget   service\nfor billing ',
        defaultBranch: 'trunk',
        private: true,
      }),
      repository('acme/api'),
      repository('acme/web'),
    ]);
  });

  it('lists the run scope live, ordered by name, with checkout state', async () => {
    const checkedOut = path.join(workspaceRootRef.current, 'acme', 'api');
    fs.mkdirSync(path.join(checkedOut, '.git'), { recursive: true });

    const result = await createCaller().commands.listRepositories();

    expect(mockFindFirstById).toHaveBeenCalledWith(1);
    expect(mockListRepositories).toHaveBeenCalledWith({
      sourceControlProvider: 'github',
    });
    expect(result).toEqual({
      success: true,
      repositories: [
        {
          fullName: 'acme/api',
          sourceControlProvider: 'github',
          defaultBranch: 'main',
          private: false,
          checkedOut: true,
          path: checkedOut,
        },
        {
          fullName: 'acme/web',
          sourceControlProvider: 'github',
          defaultBranch: 'main',
          private: false,
          checkedOut: false,
        },
        {
          fullName: 'octo/widgets',
          sourceControlProvider: 'github',
          defaultBranch: 'trunk',
          private: true,
          description: 'Widget service for billing',
          checkedOut: false,
        },
      ],
      totalCount: 3,
    });
  });

  it('requires every query term across name and description, ignoring case', async () => {
    const names = async (query: string) =>
      (
        await createCaller().commands.listRepositories({ query })
      ).repositories.map(({ fullName }) => fullName);

    expect(await names('ACME')).toEqual(['acme/api', 'acme/web']);
    expect(await names('octo billing')).toEqual(['octo/widgets']);
    expect(await names('acme billing')).toEqual([]);
  });

  it('pages with nextOffset', async () => {
    const first = await createCaller().commands.listRepositories({ limit: 2 });
    expect(first.repositories.map(({ fullName }) => fullName)).toEqual([
      'acme/api',
      'acme/web',
    ]);
    expect(first).toMatchObject({ totalCount: 3, nextOffset: 2 });

    const second = await createCaller().commands.listRepositories({
      limit: 2,
      offset: first.nextOffset,
    });
    expect(second.repositories.map(({ fullName }) => fullName)).toEqual([
      'octo/widgets',
    ]);
    expect(second.nextOffset).toBeUndefined();

    await expect(
      createCaller().commands.listRepositories({ limit: 101 }),
    ).rejects.toThrow();
  });

  it('never names a repository outside the stamped run scope', async () => {
    stubTaskRun({
      repo: 'acme/api',
      sourceControlProvider: 'github',
      repositoryProviders: {
        'acme/api': 'github',
        'acme/gitlab-app': 'gitlab',
      },
    });
    mockListRepositories.mockResolvedValue([
      repository('acme/api'),
      repository('acme/secret'),
      repository('acme/gitlab-app', { sourceControlProvider: 'gitlab' }),
    ]);

    const result = await createCaller().commands.listRepositories();

    expect(
      result.repositories.map(({ fullName, sourceControlProvider }) => [
        fullName,
        sourceControlProvider,
      ]),
    ).toEqual([
      ['acme/api', 'github'],
      ['acme/gitlab-app', 'gitlab'],
    ]);
    expect(JSON.stringify(result)).not.toContain('acme/secret');
  });

  it('refuses runs without a repository scope or an active run', async () => {
    stubTaskRun({ repo: '__no_repositories__' });
    await expect(createCaller().commands.listRepositories()).rejects.toThrow(
      'launched without connected source control',
    );

    stubTaskRun({ repo: 'acme/api', sourceControlProvider: 'github' });
    await expect(createCaller().commands.listRepositories()).rejects.toThrow(
      'no authorized repository scope',
    );

    await expect(
      createCaller({ hasRun: false }).commands.listRepositories(),
    ).rejects.toThrow('requires an active task run');
    expect(mockListRepositories).not.toHaveBeenCalled();
  });
});
