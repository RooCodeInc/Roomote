'use client';

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useRef,
  type ReactNode,
} from 'react';

interface PreviewPaneState {
  url: string;
  runId: number;
  serviceName: string | null;
}

interface PreviewPaneContextType {
  previewPaneUrl: string | null;
  previewPaneRunId: number | null;
  previewPaneServiceName: string | null;
  openPreviewPane: (url: string, runId: number, serviceName?: string) => void;
  closePreviewPane: () => void;
  /** Whether the preview pane was already auto-opened in this session. */
  hasAutoOpened: boolean;
  /** Mark the preview pane as having been auto-opened. */
  setHasAutoOpened: (value: boolean) => void;
}

const noopOpen = (_url: string, _runId: number, _serviceName?: string) => {};
const noopClose = () => {};
const noopSetBoolean = (_value: boolean) => {};

const defaultValue: PreviewPaneContextType = {
  previewPaneUrl: null,
  previewPaneRunId: null,
  previewPaneServiceName: null,
  openPreviewPane: noopOpen,
  closePreviewPane: noopClose,
  hasAutoOpened: false,
  setHasAutoOpened: noopSetBoolean,
};

const PreviewPaneContext = createContext<PreviewPaneContextType>(defaultValue);

export function usePreviewPane() {
  return useContext(PreviewPaneContext);
}

interface PreviewPaneProviderProps {
  children: ReactNode;
}

export function PreviewPaneProvider({ children }: PreviewPaneProviderProps) {
  const [state, setState] = useState<PreviewPaneState | null>(null);
  const autoOpenedRef = useRef(false);

  const hasAutoOpened = autoOpenedRef.current;
  const setHasAutoOpened = useCallback((value: boolean) => {
    autoOpenedRef.current = value;
  }, []);

  const openPreviewPane = useCallback(
    (url: string, runId: number, serviceName?: string) => {
      setState({ url, runId, serviceName: serviceName ?? null });
    },
    [],
  );

  const closePreviewPane = useCallback(() => {
    setState(null);
    // URL cleanup is now handled by use-task-side-panel via path-based routing.
  }, []);

  return (
    <PreviewPaneContext.Provider
      value={{
        previewPaneUrl: state?.url ?? null,
        previewPaneRunId: state?.runId ?? null,
        previewPaneServiceName: state?.serviceName ?? null,
        openPreviewPane,
        closePreviewPane,
        hasAutoOpened,
        setHasAutoOpened,
      }}
    >
      {children}
    </PreviewPaneContext.Provider>
  );
}
