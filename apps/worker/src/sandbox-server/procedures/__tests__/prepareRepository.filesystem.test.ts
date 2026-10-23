import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';

import { WorkspaceManager } from '../../../workspace';
import { prepareRepository } from '../prepareRepository';
import { router, type Context } from '../../trpc';

const { fixture, findRepository, listRepositories, findRun } = vi.hoisted(
  () => ({
    fixture: { workspaceRoot: '' },
    findRepository: vi.fn(),
    listRepositories: vi.fn(),
    findRun: vi.fn(),
  }),
);
vi.mock('@roomote/sdk/client', () => ({
  sdk: {
    repositories: {
      findRepository,
      listRepositories,
      reportDefaultBranch: vi.fn(),
    },
    taskRuns: { findFirstById: findRun },
  },
}));
vi.mock('../../../run-task/repository-judgement', () => ({
  installRepositoryJudgement: vi.fn(),
}));
vi.mock('../../../commands/setup/workspace/shared', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../../commands/setup/workspace/shared')
  >()),
  createWorkspaceManager: (env: Record<string, string | undefined>) => ({
    workspaceRoot: fixture.workspaceRoot,
    workspaceManager: new WorkspaceManager(fixture.workspaceRoot, env),
  }),
}));

describe('on-demand checkout preserves existing files (real filesystem and git)', () => {
  let root: string;
  let home: string;
  const fullName = 'fixture/project';
  const testRouter = router({ prepareRepository });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'roomote-checkout-files-'));
    fixture.workspaceRoot = join(root, 'workspace');
    home = join(root, 'home');
    const source = join(root, 'source');
    await Promise.all([
      mkdir(fixture.workspaceRoot),
      mkdir(home),
      mkdir(source),
    ]);
    const env = {
      PATH: process.env.PATH,
      HOME: home,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.com',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.com',
    };
    await execa('git', ['init', '-b', 'main', source], {
      env,
      extendEnv: false,
    });
    await writeFile(join(source, 'remote.txt'), 'remote fixture\n');
    await execa('git', ['-C', source, 'add', 'remote.txt'], {
      env,
      extendEnv: false,
    });
    await execa('git', ['-C', source, 'commit', '-m', 'fixture'], {
      env,
      extendEnv: false,
    });
    const repository = {
      id: 'fixture-repository',
      fullName,
      sourceControlProvider: 'gitea',
      defaultBranch: 'main',
      cloneUrl: `file://${source}`,
      private: false,
      description: null,
    };
    findRepository.mockResolvedValue(repository);
    listRepositories.mockResolvedValue([repository]);
    findRun.mockResolvedValue({
      id: 42,
      taskId: 'fixture-task',
      payload: {
        repo: '__all_repositories__',
        sourceControlProvider: 'gitea',
        repositoryProviders: { [fullName]: 'gitea' },
      },
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  function caller() {
    return testRouter.createCaller({
      workingDirectory: fixture.workspaceRoot,
      runId: 42,
      auth: null,
      harness: {} as Context['harness'],
      taskRuntime: {
        homeDir: home,
        runtimeEnv: {
          HOME: home,
          PATH: process.env.PATH,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_TERMINAL_PROMPT: '0',
        },
      },
    });
  }

  it('rejects a populated non-git destination and leaves its files intact', async () => {
    const destination = join(fixture.workspaceRoot, fullName);
    await mkdir(destination, { recursive: true });
    await writeFile(
      join(destination, 'draft.txt'),
      'uncommitted operator work\n',
    );
    const outcome = await caller()
      .prepareRepository({ repositoryFullName: fullName })
      .then(
        () => 'replaced',
        (error: Error) => error.message,
      );
    expect(existsSync(join(destination, 'draft.txt'))).toBe(true);
    expect(await readFile(join(destination, 'draft.txt'), 'utf8')).toBe(
      'uncommitted operator work\n',
    );
    expect(outcome).toMatch(/already exists.*not a git/i);
    expect(existsSync(join(destination, '.git'))).toBe(false);
  });

  it('clones normally once the operator moves the occupied directory aside', async () => {
    const occupied = join(fixture.workspaceRoot, fullName);
    const saved = join(root, 'saved-draft');
    await mkdir(occupied, { recursive: true });
    await writeFile(join(occupied, 'draft.txt'), 'saved operator work\n');
    await expect(
      caller().prepareRepository({ repositoryFullName: fullName }),
    ).rejects.toThrow(/already exists.*not a git/i);
    await rename(occupied, saved);
    const result = await caller().prepareRepository({
      repositoryFullName: fullName,
    });
    expect(result.alreadyCheckedOut).toBe(false);
    expect(
      await readFile(join(result.repositoryPath, 'remote.txt'), 'utf8'),
    ).toBe('remote fixture\n');
    await writeFile(join(result.repositoryPath, 'remote.txt'), 'local edit\n');
    const reopened = await caller().prepareRepository({
      repositoryFullName: fullName,
    });
    expect(reopened.alreadyCheckedOut).toBe(true);
    expect(
      await readFile(join(result.repositoryPath, 'remote.txt'), 'utf8'),
    ).toBe('local edit\n');
    expect(await readFile(join(saved, 'draft.txt'), 'utf8')).toBe(
      'saved operator work\n',
    );
  });

  it('recovers an empty interrupted clone directory', async () => {
    await mkdir(join(fixture.workspaceRoot, fullName), { recursive: true });
    const result = await caller().prepareRepository({
      repositoryFullName: fullName,
    });
    expect(result.alreadyCheckedOut).toBe(false);
    expect(
      await readFile(join(result.repositoryPath, 'remote.txt'), 'utf8'),
    ).toBe('remote fixture\n');
  });

  it('preserves a file occupying the destination path', async () => {
    const destination = join(fixture.workspaceRoot, fullName);
    await mkdir(join(fixture.workspaceRoot, 'fixture'));
    await writeFile(destination, 'operator note\n');
    await expect(
      caller().prepareRepository({ repositoryFullName: fullName }),
    ).rejects.toThrow(/already exists.*not a git/i);
    expect(await readFile(destination, 'utf8')).toBe('operator note\n');
  });
});
