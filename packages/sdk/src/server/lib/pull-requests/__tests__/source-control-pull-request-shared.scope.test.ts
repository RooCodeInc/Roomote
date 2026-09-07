import {
  db,
  resolveTaskRunWritableRepositories,
  type Repository,
  type TaskRun,
} from '@roomote/db/server';
import {
  assertRepositoryInTaskRunScope,
  resolveTaskRunSourceControlRepository,
} from '../source-control-pull-request-shared';

vi.mock('@roomote/db/server', () => ({
  db: { query: { repositories: { findMany: vi.fn() } } },
  resolveTaskRunWritableRepositories: vi.fn(),
  repositories: {},
  and: vi.fn(),
  eq: vi.fn(),
}));
vi.mock('@roomote/gitlab', () => ({ isGitLabOAuthAccessToken: vi.fn() }));

const repository = {
  id: 'target',
  fullName: 'acme/target',
  sourceControlProvider: 'gitlab',
  host: 'gitlab.example.com',
  isActive: true,
} as Repository;
const taskRun = {
  id: 123,
  actingUserId: 'actor',
  payload: {
    environmentId: 'environment',
    repo: 'acme/prepared',
    sourceControlProvider: 'github',
    sourceControlHost: 'github.com',
    repositoryProviders: { 'acme/prepared': 'github' },
  },
} as unknown as TaskRun;

beforeEach(() => {
  vi.resetAllMocks();
});

describe('environment source-control repository resolution', () => {
  it.each([false, true])(
    'uses the writable row with stale payload mapping=%s',
    async (mapped) => {
      vi.mocked(resolveTaskRunWritableRepositories).mockResolvedValue([
        repository,
      ]);
      const run = {
        ...taskRun,
        payload: {
          ...taskRun.payload,
          repositoryProviders: {
            'acme/prepared': 'github',
            ...(mapped ? { 'acme/target': 'github' } : {}),
          },
        },
      } as TaskRun;
      await expect(
        resolveTaskRunSourceControlRepository(run, {
          repositoryFullName: 'acme/target',
          sourceControlProvider: 'gitlab',
        }),
      ).resolves.toBe(repository);
      expect(resolveTaskRunWritableRepositories).toHaveBeenCalledWith(db, run);
      expect(db.query.repositories.findMany).not.toHaveBeenCalled();
      await expect(
        assertRepositoryInTaskRunScope(run, 'acme/target'),
      ).resolves.toBeUndefined();
    },
  );

  it.each([{ rows: [] }, { rows: [{ ...repository, isActive: false }] }])(
    'rejects missing or inactive writable targets',
    async ({ rows }) => {
      vi.mocked(resolveTaskRunWritableRepositories).mockResolvedValue(rows);
      await expect(
        resolveTaskRunSourceControlRepository(taskRun, {
          repositoryFullName: 'acme/target',
        }),
      ).rejects.toThrow('not found, inactive, or outside');
      expect(db.query.repositories.findMany).not.toHaveBeenCalled();
    },
  );

  it('propagates current-actor authorization rejection without falling back to prepared scope', async () => {
    vi.mocked(resolveTaskRunWritableRepositories).mockRejectedValue(
      new Error('Actor is not an active deployment member'),
    );
    await expect(
      resolveTaskRunSourceControlRepository(taskRun, {
        repositoryFullName: 'acme/prepared',
      }),
    ).rejects.toThrow('not an active deployment member');
    expect(db.query.repositories.findMany).not.toHaveBeenCalled();
  });

  it('retains the input provider safety check against the actual row', async () => {
    vi.mocked(resolveTaskRunWritableRepositories).mockResolvedValue([
      repository,
    ]);
    await expect(
      resolveTaskRunSourceControlRepository(taskRun, {
        repositoryFullName: 'acme/target',
        sourceControlProvider: 'github',
      }),
    ).rejects.toThrow('provider mismatch');
  });

  it('rejects same-name repositories on different providers even with a host hint', async () => {
    vi.mocked(resolveTaskRunWritableRepositories).mockResolvedValue([
      repository,
      {
        ...repository,
        id: 'other',
        sourceControlProvider: 'github',
        host: 'github.com',
      },
    ]);
    await expect(
      resolveTaskRunSourceControlRepository(taskRun, {
        repositoryFullName: 'acme/target',
      }),
    ).rejects.toThrow('more than one writable');
  });

  it('uses an applicable prepared host only to disambiguate same-provider rows', async () => {
    vi.mocked(resolveTaskRunWritableRepositories).mockResolvedValue([
      repository,
      { ...repository, id: 'other', host: 'other.example.com' },
    ]);
    await expect(
      resolveTaskRunSourceControlRepository(taskRun, {
        repositoryFullName: 'acme/target',
      }),
    ).rejects.toThrow('more than one writable');
    const run = {
      ...taskRun,
      payload: {
        ...taskRun.payload,
        sourceControlProvider: 'gitlab',
        sourceControlHost: repository.host,
      },
    } as TaskRun;
    await expect(
      resolveTaskRunSourceControlRepository(run, {
        repositoryFullName: 'acme/target',
      }),
    ).resolves.toBe(repository);
  });

  it('retains explicit non-environment repository choices', async () => {
    vi.mocked(resolveTaskRunWritableRepositories).mockResolvedValue(null);
    const run = {
      ...taskRun,
      payload: { repo: 'acme/prepared', sourceControlProvider: 'gitlab' },
    } as TaskRun;
    await expect(
      resolveTaskRunSourceControlRepository(run, {
        repositoryFullName: 'acme/target',
      }),
    ).rejects.toThrow('outside this task');
    vi.mocked(db.query.repositories.findMany).mockResolvedValue([repository]);
    const selectedRun = {
      ...run,
      payload: { ...run.payload, selectedRepositories: ['acme/target'] },
    } as TaskRun;
    await expect(
      resolveTaskRunSourceControlRepository(selectedRun, {
        repositoryFullName: 'acme/target',
      }),
    ).resolves.toBe(repository);
  });
});
