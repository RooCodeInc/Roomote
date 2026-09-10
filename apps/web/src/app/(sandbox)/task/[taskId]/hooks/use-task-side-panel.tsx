'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { usePathname, useSearchParams } from 'next/navigation';

import type { TaskArtifact } from '@/types';
import { groupArtifactsByPath } from '../sidebar-actions/utils';

type TaskSidePanelView =
  | 'preview'
  | 'artifacts'
  | 'task-info'
  | 'diff'
  | 'terminal'
  | 'logs';
type ArtifactsMode = 'browser' | 'detail';

interface TaskSidePanelContextType {
  hasProvider: boolean;
  activeView: TaskSidePanelView | null;
  artifactsMode: ArtifactsMode;
  selectedArtifactPath: string | null;
  selectedArtifactVersion?: number;
  canGoToPreviousArtifact: boolean;
  canGoToNextArtifact: boolean;
  /** The service name currently shown in the preview panel (from URL or last opened). */
  previewServiceName: string | null;
  /** The iframe path currently shown in the preview panel (from URL or last opened). */
  previewPath: string | null;
  openPreviewView: (url: string, runId: number, serviceName?: string) => void;
  /** Open the preview pane without a running preview (shows the setup state). */
  openPreviewSetupView: () => void;
  openArtifactsBrowser: () => void;
  openDiffView: () => void;
  openArtifactDetail: (path: string, version?: number) => void;
  openTaskInfoView: () => void;
  openTerminalView: () => void;
  openLogsView: () => void;
  closeSidePanel: () => void;
  goBackToArtifactsBrowser: () => void;
  goToPreviousArtifact: () => void;
  goToNextArtifact: () => void;
  setArtifactVersion: (version: number) => void;
  /** Update the preview path in the URL (replaceState) without changing view. */
  updatePreviewPath: (iframePath: string) => void;
  isViewActive: (view: TaskSidePanelView) => boolean;
}

const noop = () => {};

const defaultValue: TaskSidePanelContextType = {
  hasProvider: false,
  activeView: null,
  artifactsMode: 'browser',
  selectedArtifactPath: null,
  selectedArtifactVersion: undefined,
  canGoToPreviousArtifact: false,
  canGoToNextArtifact: false,
  previewServiceName: null,
  previewPath: null,
  openPreviewView: noop,
  openPreviewSetupView: noop,
  openArtifactsBrowser: noop,
  openDiffView: noop,
  openArtifactDetail: noop,
  openTaskInfoView: noop,
  openTerminalView: noop,
  openLogsView: noop,
  closeSidePanel: noop,
  goBackToArtifactsBrowser: noop,
  goToPreviousArtifact: noop,
  goToNextArtifact: noop,
  setArtifactVersion: noop,
  updatePreviewPath: noop,
  isViewActive: () => false,
};

const TaskSidePanelContext =
  createContext<TaskSidePanelContextType>(defaultValue);

export function useTaskSidePanel() {
  return useContext(TaskSidePanelContext);
}

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

/** Strip any panel sub-path to get the bare `/task/[id]` base path. */
function computeBasePath(pathname: string): string {
  return pathname.replace(
    /\/(artifacts|previews|info|diff|terminal|logs)(\/.*)?$/,
    '',
  );
}

function buildArtifactDetailPath(
  basePath: string,
  path: string,
  version?: number,
): string {
  const search = new URLSearchParams({ path });
  if (version !== undefined) search.set('v', String(version));
  return `${basePath}/artifacts?${search}`;
}

/**
 * Parse the current pathname to determine which panel (if any) should be
 * active and extract its parameters.
 */
function parseViewFromPathname(
  pathname: string,
  search: URLSearchParams,
): {
  view: TaskSidePanelView | null;
  artifactsMode: ArtifactsMode;
  artifactPath: string | null;
  artifactVersion: number | undefined;
  previewServiceName: string | null;
  previewPath: string | null;
} {
  // /task/[id]/artifacts/[...path]?v=N
  const artifactMatch = pathname.match(/\/artifacts(?:\/(.+))?$/);
  if (artifactMatch) {
    const routePath = artifactMatch[1];
    const path = routePath ? decodeURIComponent(routePath) : search.get('path');
    const versionParam = search.get('v');
    const parsed = versionParam ? parseInt(versionParam, 10) : undefined;
    const version = Number.isNaN(parsed) ? undefined : parsed;

    return {
      view: 'artifacts',
      artifactsMode: path ? 'detail' : 'browser',
      artifactPath: path,
      artifactVersion: version,
      previewServiceName: null,
      previewPath: null,
    };
  }

  // /task/[id]/previews/[service]?path=[path]
  const previewMatch = pathname.match(/\/previews\/([^/]+)/);
  if (previewMatch) {
    const serviceName = decodeURIComponent(previewMatch[1]!);
    const iframePath = search.get('path') ?? null;
    return {
      view: 'preview',
      artifactsMode: 'browser',
      artifactPath: null,
      artifactVersion: undefined,
      previewServiceName: serviceName,
      previewPath: iframePath,
    };
  }

  // /task/[id]/previews — preview pane without a running preview (setup state)
  if (/\/previews\/?$/.test(pathname)) {
    return {
      view: 'preview',
      artifactsMode: 'browser',
      artifactPath: null,
      artifactVersion: undefined,
      previewServiceName: null,
      previewPath: null,
    };
  }

  // /task/[id]/info
  if (/\/info\/?$/.test(pathname)) {
    return {
      view: 'task-info',
      artifactsMode: 'browser',
      artifactPath: null,
      artifactVersion: undefined,
      previewServiceName: null,
      previewPath: null,
    };
  }

  // /task/[id]/diff
  if (/\/diff\/?$/.test(pathname)) {
    return {
      view: 'diff',
      artifactsMode: 'browser',
      artifactPath: null,
      artifactVersion: undefined,
      previewServiceName: null,
      previewPath: null,
    };
  }

  // /task/[id]/terminal
  if (/\/terminal\/?$/.test(pathname)) {
    return {
      view: 'terminal',
      artifactsMode: 'browser',
      artifactPath: null,
      artifactVersion: undefined,
      previewServiceName: null,
      previewPath: null,
    };
  }

  // /task/[id]/logs
  if (/\/logs\/?$/.test(pathname)) {
    return {
      view: 'logs',
      artifactsMode: 'browser',
      artifactPath: null,
      artifactVersion: undefined,
      previewServiceName: null,
      previewPath: null,
    };
  }
  return {
    view: null,
    artifactsMode: 'browser',
    artifactPath: null,
    artifactVersion: undefined,
    previewServiceName: null,
    previewPath: null,
  };
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

interface TaskSidePanelProviderProps {
  taskId: string;
  artifacts: TaskArtifact[];
  children: ReactNode;
}

export function TaskSidePanelProvider({
  taskId,
  artifacts,
  children,
}: TaskSidePanelProviderProps) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [activeView, setActiveView] = useState<TaskSidePanelView | null>(null);
  const [artifactsMode, setArtifactsMode] = useState<ArtifactsMode>('browser');
  const [selectedArtifactPath, setSelectedArtifactPath] = useState<
    string | null
  >(null);
  const [selectedArtifactVersion, setSelectedArtifactVersion] = useState<
    number | undefined
  >();
  const [previewServiceName, setPreviewServiceName] = useState<string | null>(
    null,
  );
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const artifactGroups = useMemo(
    () => groupArtifactsByPath(artifacts),
    [artifacts],
  );

  const selectedArtifactIndex = useMemo(
    () =>
      selectedArtifactPath
        ? artifactGroups.findIndex(
            (group) => group.path === selectedArtifactPath,
          )
        : -1,
    [artifactGroups, selectedArtifactPath],
  );

  const basePath = useMemo(() => computeBasePath(pathname), [pathname]);
  const buildPreviewPath = useCallback(
    (serviceName: string, path?: string | null) => {
      return path && path !== '/'
        ? `${basePath}/previews/${encodeURIComponent(serviceName)}?path=${encodeURIComponent(path)}`
        : `${basePath}/previews/${encodeURIComponent(serviceName)}`;
    },
    [basePath],
  );

  // -------------------------------------------------------------------
  // Navigate to the base task path (no panel open)
  // -------------------------------------------------------------------
  const navigateToBase = useCallback(() => {
    if (window.location.pathname !== basePath) {
      window.history.replaceState(window.history.state, '', basePath);
    }
  }, [basePath]);

  // -------------------------------------------------------------------
  // Open preview view
  // -------------------------------------------------------------------
  const openPreviewView = useCallback(
    (url: string, _runId: number, serviceName?: string) => {
      setActiveView('preview');

      const service = serviceName ?? previewServiceName;
      if (service) {
        setPreviewServiceName(service);
      }

      let resolvedPath = previewPath ?? undefined;

      try {
        const parsedUrl = new URL(url);
        resolvedPath =
          `${parsedUrl.pathname}${parsedUrl.search}${parsedUrl.hash}` || '/';
      } catch {
        // Ignore malformed URLs and keep the last known path.
      }

      setPreviewPath(resolvedPath ?? null);

      if (service) {
        window.history.replaceState(
          window.history.state,
          '',
          buildPreviewPath(service, resolvedPath),
        );
      }
    },
    [buildPreviewPath, previewPath, previewServiceName],
  );

  // -------------------------------------------------------------------
  // Open preview pane without a running preview (setup state)
  // -------------------------------------------------------------------
  const openPreviewSetupView = useCallback(() => {
    setActiveView('preview');
    window.history.replaceState(
      window.history.state,
      '',
      `${basePath}/previews`,
    );
  }, [basePath]);

  // -------------------------------------------------------------------
  // Open artifacts browser (list view)
  // -------------------------------------------------------------------
  const openArtifactsBrowser = useCallback(() => {
    setActiveView('artifacts');
    setArtifactsMode('browser');
    window.history.replaceState(
      window.history.state,
      '',
      `${basePath}/artifacts`,
    );
  }, [basePath]);

  // -------------------------------------------------------------------
  // Open artifact detail view
  // -------------------------------------------------------------------
  const openArtifactDetail = useCallback(
    (path: string, version?: number) => {
      setActiveView('artifacts');
      setArtifactsMode('detail');
      setSelectedArtifactPath(path);
      setSelectedArtifactVersion(version);

      window.history.replaceState(
        null,
        '',
        buildArtifactDetailPath(basePath, path, version),
      );
    },
    [basePath],
  );

  // -------------------------------------------------------------------
  // Open task info view
  // -------------------------------------------------------------------
  const openTaskInfoView = useCallback(() => {
    setActiveView('task-info');
    window.history.replaceState(window.history.state, '', `${basePath}/info`);
  }, [basePath]);

  // -------------------------------------------------------------------
  // Open terminal view
  // -------------------------------------------------------------------
  const openTerminalView = useCallback(() => {
    setActiveView('terminal');
    window.history.replaceState(
      window.history.state,
      '',
      `${basePath}/terminal`,
    );
  }, [basePath]);

  // -------------------------------------------------------------------
  // Open logs view
  // -------------------------------------------------------------------
  const openLogsView = useCallback(() => {
    setActiveView('logs');
    window.history.replaceState(window.history.state, '', `${basePath}/logs`);
  }, [basePath]);

  // Open diff view
  // -------------------------------------------------------------------
  const openDiffView = useCallback(() => {
    setActiveView('diff');
    window.history.replaceState(window.history.state, '', `${basePath}/diff`);
  }, [basePath]);

  // -------------------------------------------------------------------
  // Close side panel → navigate back to base task path
  // -------------------------------------------------------------------
  const closeSidePanel = useCallback(() => {
    setActiveView(null);
    navigateToBase();
  }, [navigateToBase]);

  // -------------------------------------------------------------------
  // Go back to artifacts browser from detail view
  // -------------------------------------------------------------------
  const goBackToArtifactsBrowser = useCallback(() => {
    setArtifactsMode('browser');
    window.history.replaceState(
      window.history.state,
      '',
      `${basePath}/artifacts`,
    );
  }, [basePath]);

  // -------------------------------------------------------------------
  // Set artifact version (replaceState to avoid history spam)
  // -------------------------------------------------------------------
  const setArtifactVersion = useCallback(
    (version: number) => {
      setSelectedArtifactVersion(version);

      if (selectedArtifactPath) {
        window.history.replaceState(
          null,
          '',
          buildArtifactDetailPath(basePath, selectedArtifactPath, version),
        );
      }
    },
    [basePath, selectedArtifactPath],
  );

  // -------------------------------------------------------------------
  // Navigate between artifacts
  // -------------------------------------------------------------------
  const goToRelativeArtifact = useCallback(
    (offset: -1 | 1) => {
      const nextGroup = artifactGroups[selectedArtifactIndex + offset];

      if (!nextGroup) {
        return;
      }

      openArtifactDetail(nextGroup.latest.path, nextGroup.latest.version);
    },
    [artifactGroups, openArtifactDetail, selectedArtifactIndex],
  );

  const goToPreviousArtifact = useCallback(() => {
    goToRelativeArtifact(-1);
  }, [goToRelativeArtifact]);

  const goToNextArtifact = useCallback(() => {
    goToRelativeArtifact(1);
  }, [goToRelativeArtifact]);

  // -------------------------------------------------------------------
  // Update preview path (replaceState — called by PreviewSidePanel on
  // iframe navigation)
  // -------------------------------------------------------------------
  const updatePreviewPath = useCallback(
    (iframePath: string) => {
      if (activeView === 'preview' && previewServiceName) {
        setPreviewPath(iframePath);
        window.history.replaceState(
          window.history.state,
          '',
          buildPreviewPath(previewServiceName, iframePath),
        );
        return;
      }
    },
    [activeView, buildPreviewPath, previewServiceName],
  );

  const isViewActive = useCallback(
    (view: TaskSidePanelView) => activeView === view,
    [activeView],
  );

  // -------------------------------------------------------------------
  // Sync state from URL on initial load / URL changes
  // -------------------------------------------------------------------
  useEffect(() => {
    const parsed = parseViewFromPathname(pathname, searchParams);

    if (parsed.view === null) {
      // URL has no side-panel segment; keep UI in sync by ensuring panel is closed.
      setActiveView((current) => (current === null ? current : null));
      return;
    }

    setActiveView(parsed.view);

    if (parsed.view === 'artifacts') {
      setArtifactsMode(parsed.artifactsMode);

      if (parsed.artifactPath) {
        setSelectedArtifactPath((current) =>
          current === parsed.artifactPath ? current : parsed.artifactPath,
        );
      }

      setSelectedArtifactVersion((current) =>
        current === parsed.artifactVersion ? current : parsed.artifactVersion,
      );
    }

    if (parsed.view === 'preview') {
      setPreviewServiceName((current) =>
        current === parsed.previewServiceName
          ? current
          : parsed.previewServiceName,
      );
      setPreviewPath((current) =>
        current === parsed.previewPath ? current : parsed.previewPath,
      );
    }
  }, [pathname, searchParams, taskId]);

  const value = useMemo(
    () => ({
      hasProvider: true,
      activeView,
      artifactsMode,
      selectedArtifactPath,
      selectedArtifactVersion,
      canGoToPreviousArtifact: selectedArtifactIndex > 0,
      canGoToNextArtifact:
        selectedArtifactIndex >= 0 &&
        selectedArtifactIndex < artifactGroups.length - 1,
      previewServiceName,
      previewPath,
      openPreviewView,
      openPreviewSetupView,
      openArtifactsBrowser,
      openArtifactDetail,
      openTaskInfoView,
      openTerminalView,
      openLogsView,
      openDiffView,
      closeSidePanel,
      goBackToArtifactsBrowser,
      goToPreviousArtifact,
      goToNextArtifact,
      setArtifactVersion,
      updatePreviewPath,
      isViewActive,
    }),
    [
      activeView,
      artifactGroups.length,
      artifactsMode,
      closeSidePanel,
      goBackToArtifactsBrowser,
      goToNextArtifact,
      goToPreviousArtifact,
      isViewActive,
      openArtifactDetail,
      openArtifactsBrowser,
      openLogsView,
      openPreviewView,
      openPreviewSetupView,
      openTerminalView,
      openTaskInfoView,
      openDiffView,
      previewPath,
      previewServiceName,
      selectedArtifactIndex,
      selectedArtifactPath,
      selectedArtifactVersion,
      setArtifactVersion,
      updatePreviewPath,
    ],
  );

  return (
    <TaskSidePanelContext.Provider value={value}>
      {children}
    </TaskSidePanelContext.Provider>
  );
}
