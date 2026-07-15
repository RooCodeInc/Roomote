import type { ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';

vi.mock('@roomote/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@roomote/env')>();

  return {
    ...actual,
    Env: {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://postgres:password@localhost:5432/test',
    },
  };
});

import { createSandboxStore } from '../use-sandbox-store';
import { SandboxStoreContext } from '../SandboxProvider';
import { useLogFiles } from '../use-log-files';

const useEnvironmentMock = vi.fn((_id: string | undefined) => ({
  data: undefined as
    | {
        config?: {
          repositories?: Array<{
            repository: string;
            commands?: Array<{ name: string; logfile?: string }>;
          }>;
          docker_projects?: Array<{ name: string }>;
        };
      }
    | undefined,
}));

const getSetupStatusQueryMock = vi.fn();

vi.mock('@/hooks/environments', () => ({
  useEnvironment: (id: string | undefined) => useEnvironmentMock(id),
}));

vi.mock('../SandboxProvider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../SandboxProvider')>();

  return {
    ...actual,
    useSandboxClient: () => ({
      commands: {
        getSetupStatus: {
          query: getSetupStatusQueryMock,
        },
      },
    }),
  };
});

function createWrapper(store: ReturnType<typeof createSandboxStore>) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <SandboxStoreContext.Provider value={store}>
        {children}
      </SandboxStoreContext.Provider>
    );
  };
}

describe('useLogFiles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useEnvironmentMock.mockReturnValue({ data: undefined });
    getSetupStatusQueryMock.mockResolvedValue({
      path: '.roomote/setup-status.json',
      exists: false,
      status: null,
    });
  });

  it('reads existing logfiles without syncing when called without inputs', async () => {
    const store = createSandboxStore();
    const existing = [{ label: 'Existing', filePath: '/tmp/existing.log' }];
    store.getState().setLogfiles(existing);

    const { result } = renderHook(() => useLogFiles(), {
      wrapper: createWrapper(store),
    });

    await waitFor(() => {
      expect(result.current).toEqual(existing);
    });

    expect(store.getState().logfiles).toEqual(existing);
    expect(useEnvironmentMock).toHaveBeenCalledWith(undefined);
    expect(getSetupStatusQueryMock).not.toHaveBeenCalled();
  });

  it('clears stale logfiles when called with an explicit undefined environment id', async () => {
    const store = createSandboxStore();
    store
      .getState()
      .setLogfiles([{ label: 'Stale', filePath: '/tmp/stale.log' }]);

    renderHook(() => useLogFiles(undefined), {
      wrapper: createWrapper(store),
    });

    await waitFor(() => {
      expect(store.getState().logfiles).toEqual([
        { label: 'harness.log', filePath: '/tmp/harness.log' },
      ]);
    });

    expect(useEnvironmentMock).toHaveBeenCalledWith(undefined);
  });

  it('merges setup command log files from the sandbox setup status', async () => {
    useEnvironmentMock.mockReturnValue({
      data: {
        config: {
          repositories: [
            {
              repository: 'RooCodeInc/Roomote',
              commands: [
                { name: 'Start Redis', logfile: '/tmp/roomote-redis.log' },
              ],
            },
          ],
        },
      },
    });

    getSetupStatusQueryMock.mockResolvedValue({
      path: '.roomote/setup-status.json',
      exists: true,
      status: {
        version: 1,
        state: 'completed',
        startedAt: '2026-07-14T00:00:00.000Z',
        commands: [
          {
            repository: 'RooCodeInc/Roomote',
            name: 'Install toolchain and dependencies',
            state: 'succeeded',
            logFile:
              '.roomote/setup-logs/RooCodeInc/Roomote/install-toolchain-and-dependencies.log',
          },
          {
            repository: 'RooCodeInc/Roomote',
            name: 'Start Redis',
            state: 'started_detached',
            // Same path as env config; should dedupe.
            logFile: '/tmp/roomote-redis.log',
          },
          {
            repository: 'RooCodeInc/Roomote',
            name: 'Install Mintlify CLI for docs',
            state: 'running',
          },
        ],
        warnings: [],
      },
    });

    const store = createSandboxStore();

    renderHook(() => useLogFiles('env-1'), {
      wrapper: createWrapper(store),
    });

    await waitFor(() => {
      expect(store.getState().logfiles).toEqual([
        { label: 'harness.log', filePath: '/tmp/harness.log' },
        { label: 'Start Redis', filePath: '/tmp/roomote-redis.log' },
        {
          label: 'Setup: Install toolchain and dependencies',
          filePath:
            '.roomote/setup-logs/RooCodeInc/Roomote/install-toolchain-and-dependencies.log',
        },
      ]);
    });

    expect(getSetupStatusQueryMock).toHaveBeenCalled();
  });

  it('disambiguates setup log labels only when names collide', async () => {
    useEnvironmentMock.mockReturnValue({ data: undefined });

    getSetupStatusQueryMock.mockResolvedValue({
      path: '.roomote/setup-status.json',
      exists: true,
      status: {
        version: 1,
        state: 'completed',
        startedAt: '2026-07-14T00:00:00.000Z',
        commands: [
          {
            repository: 'owner-a/web',
            name: 'Install dependencies',
            state: 'succeeded',
            logFile: '.roomote/setup-logs/owner-a/web/install-dependencies.log',
          },
          {
            repository: 'owner-b/web',
            name: 'Install dependencies',
            state: 'succeeded',
            logFile: '.roomote/setup-logs/owner-b/web/install-dependencies.log',
          },
          {
            repository: 'RooCodeInc/Roomote',
            name: 'Install dependencies',
            state: 'succeeded',
            logFile:
              '.roomote/setup-logs/RooCodeInc/Roomote/install-dependencies.log',
          },
          {
            repository: 'RooCodeInc/Roomote',
            name: 'Install dependencies',
            state: 'succeeded',
            logFile:
              '.roomote/setup-logs/RooCodeInc/Roomote/install-dependencies-2.log',
          },
          {
            repository: 'RooCodeInc/Roomote',
            name: 'Migrate database',
            state: 'succeeded',
            logFile:
              '.roomote/setup-logs/RooCodeInc/Roomote/migrate-database.log',
          },
        ],
        warnings: [],
      },
    });

    const store = createSandboxStore();

    renderHook(() => useLogFiles('env-1'), {
      wrapper: createWrapper(store),
    });

    await waitFor(() => {
      expect(store.getState().logfiles).toEqual([
        { label: 'harness.log', filePath: '/tmp/harness.log' },
        {
          label: 'Setup: Install dependencies (owner-a/web)',
          filePath: '.roomote/setup-logs/owner-a/web/install-dependencies.log',
        },
        {
          label: 'Setup: Install dependencies (owner-b/web)',
          filePath: '.roomote/setup-logs/owner-b/web/install-dependencies.log',
        },
        {
          label: 'Setup: Install dependencies (RooCodeInc/Roomote)',
          filePath:
            '.roomote/setup-logs/RooCodeInc/Roomote/install-dependencies.log',
        },
        {
          label: 'Setup: Install dependencies (RooCodeInc/Roomote) 2',
          filePath:
            '.roomote/setup-logs/RooCodeInc/Roomote/install-dependencies-2.log',
        },
        {
          label: 'Setup: Migrate database',
          filePath:
            '.roomote/setup-logs/RooCodeInc/Roomote/migrate-database.log',
        },
      ]);
    });
  });
});
