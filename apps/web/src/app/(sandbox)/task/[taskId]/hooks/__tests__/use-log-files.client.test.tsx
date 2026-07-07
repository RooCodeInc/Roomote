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
  data: undefined,
}));

vi.mock('@/hooks/environments', () => ({
  useEnvironment: (id: string | undefined) => useEnvironmentMock(id),
}));

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
});
