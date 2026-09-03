import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { usePathname, useSearchParams } from 'next/navigation';

import {
  TaskSidePanelProvider,
  useTaskSidePanel,
} from '../use-task-side-panel';

let pathname = '/task/task-1';
let searchParams = new URLSearchParams();

vi.mock('next/navigation', () => ({
  usePathname: vi.fn(() => pathname),
  useSearchParams: vi.fn(() => searchParams),
}));

const mockedUsePathname = vi.mocked(usePathname);
const mockedUseSearchParams = vi.mocked(useSearchParams);

function replaceLocation(path: string) {
  window.history.replaceState(null, '', path);
}

function createWrapper() {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <TaskSidePanelProvider taskId="task-1" artifacts={[]}>
        {children}
      </TaskSidePanelProvider>
    );
  };
}

describe('useTaskSidePanel URL sync', () => {
  beforeEach(() => {
    pathname = '/task/task-1/artifacts/plans/test.md';
    searchParams = new URLSearchParams('v=1');

    mockedUsePathname.mockImplementation(() => pathname);
    mockedUseSearchParams.mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => searchParams as any,
    );

    replaceLocation(`${pathname}?v=1`);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('closes the panel when URL returns to the base task path', async () => {
    const { result, rerender } = renderHook(() => useTaskSidePanel(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.activeView).toBe('artifacts');
    });

    pathname = '/task/task-1';
    searchParams = new URLSearchParams();
    replaceLocation(pathname);

    rerender();

    await waitFor(() => {
      expect(result.current.activeView).toBeNull();
    });
  });

  it('parses query-based artifact paths without browser normalization', async () => {
    pathname = '/task/task-1/artifacts';
    searchParams = new URLSearchParams('path=plans%2F.%2Fdraft.md&v=2');
    replaceLocation(`${pathname}?${searchParams.toString()}`);

    const { result } = renderHook(() => useTaskSidePanel(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.activeView).toBe('artifacts');
      expect(result.current.artifactsMode).toBe('detail');
      expect(result.current.selectedArtifactPath).toBe('plans/./draft.md');
      expect(result.current.selectedArtifactVersion).toBe(2);
    });
  });

  it('writes query-based artifact paths when opening artifact details', async () => {
    pathname = '/task/task-1';
    searchParams = new URLSearchParams();
    replaceLocation(pathname);
    const replaceStateSpy = vi.spyOn(window.history, 'replaceState');

    const { result } = renderHook(() => useTaskSidePanel(), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.openArtifactDetail('plans/./draft.md', 2);
    });

    expect(replaceStateSpy).toHaveBeenCalledWith(
      null,
      '',
      '/task/task-1/artifacts?path=plans%2F.%2Fdraft.md&v=2',
    );
  });

  it('parses the terminal route as an active side panel view', async () => {
    pathname = '/task/task-1/terminal';
    searchParams = new URLSearchParams();
    replaceLocation(pathname);

    const { result } = renderHook(() => useTaskSidePanel(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.activeView).toBe('terminal');
    });
  });

  it('updates the URL when opening the logs view', async () => {
    pathname = '/task/task-1';
    searchParams = new URLSearchParams();
    replaceLocation(pathname);
    const replaceStateSpy = vi.spyOn(window.history, 'replaceState');

    const { result } = renderHook(() => useTaskSidePanel(), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.openLogsView();
    });

    await waitFor(() => {
      expect(result.current.activeView).toBe('logs');
    });

    expect(replaceStateSpy).toHaveBeenCalledWith(
      window.history.state,
      '',
      '/task/task-1/logs',
    );
  });
  it('parses preview routes into the Live Preview side panel', async () => {
    pathname = '/task/task-1/previews/WEB';
    searchParams = new URLSearchParams('path=%2Flogin');
    replaceLocation(`${pathname}?${searchParams.toString()}`);
    const replaceStateSpy = vi.spyOn(window.history, 'replaceState');

    const { result } = renderHook(() => useTaskSidePanel(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.activeView).toBe('preview');
    });

    expect(result.current.previewServiceName).toBe('WEB');
    expect(result.current.previewPath).toBe('/login');

    act(() => {
      result.current.openPreviewView(
        'https://task-web.preview.roomote.run/login',
        123,
        'WEB',
      );
    });

    expect(replaceStateSpy).toHaveBeenCalledWith(
      window.history.state,
      '',
      '/task/task-1/previews/WEB?path=%2Flogin',
    );

    act(() => {
      result.current.updatePreviewPath('/settings?tab=team');
    });

    expect(replaceStateSpy).toHaveBeenCalledWith(
      window.history.state,
      '',
      '/task/task-1/previews/WEB?path=%2Fsettings%3Ftab%3Dteam',
    );
  });

  it('keeps the remembered Live Preview route after switching to logs', async () => {
    pathname = '/task/task-1/previews/API';
    searchParams = new URLSearchParams('path=%2Fdocs%3Ftab%3Dapi');
    replaceLocation(`${pathname}?${searchParams.toString()}`);
    const replaceStateSpy = vi.spyOn(window.history, 'replaceState');

    const { result, rerender } = renderHook(() => useTaskSidePanel(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.activeView).toBe('preview');
    });

    expect(result.current.previewServiceName).toBe('API');
    expect(result.current.previewPath).toBe('/docs?tab=api');

    act(() => {
      result.current.openLogsView();
    });

    pathname = '/task/task-1/logs';
    searchParams = new URLSearchParams();
    replaceLocation(pathname);

    rerender();

    await waitFor(() => {
      expect(result.current.activeView).toBe('logs');
    });

    expect(result.current.previewServiceName).toBe('API');
    expect(result.current.previewPath).toBe('/docs?tab=api');

    act(() => {
      result.current.openPreviewView(
        'https://api.preview.test/docs?tab=api',
        123,
        'API',
      );
    });

    expect(replaceStateSpy).toHaveBeenCalledWith(
      window.history.state,
      '',
      '/task/task-1/previews/API?path=%2Fdocs%3Ftab%3Dapi',
    );
  });

  it('omits the preview path query when the Live Preview path is root', async () => {
    pathname = '/task/task-1/previews/WEB';
    searchParams = new URLSearchParams();
    replaceLocation(pathname);
    const replaceStateSpy = vi.spyOn(window.history, 'replaceState');

    const { result } = renderHook(() => useTaskSidePanel(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.activeView).toBe('preview');
    });

    act(() => {
      result.current.openPreviewView(
        'https://task-web.preview.roomote.run/',
        123,
        'WEB',
      );
    });

    expect(replaceStateSpy).toHaveBeenCalledWith(
      window.history.state,
      '',
      '/task/task-1/previews/WEB',
    );

    act(() => {
      result.current.updatePreviewPath('/');
    });

    expect(replaceStateSpy).toHaveBeenCalledWith(
      window.history.state,
      '',
      '/task/task-1/previews/WEB',
    );
  });
});
