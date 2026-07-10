'use client';

import { type ReactNode, createContext, useCallback, useContext } from 'react';

import type { TaskSession } from './use-task-session';

import { useTaskSidePanel } from './use-task-side-panel';

interface ArtifactLinkContextType {
  openArtifact: (path: string, version?: number) => void;
}

const ArtifactLinkContext = createContext<ArtifactLinkContextType | null>(null);

export function useArtifactLink() {
  return useContext(ArtifactLinkContext);
}

interface ArtifactLinkProviderProps {
  session: TaskSession;
  children: ReactNode;
}

export function ArtifactLinkProvider({
  session: _session,
  children,
}: ArtifactLinkProviderProps) {
  const { openArtifactDetail } = useTaskSidePanel();

  const openArtifact = useCallback(
    (path: string, version?: number) => {
      openArtifactDetail(path, version);
    },
    [openArtifactDetail],
  );

  return (
    <ArtifactLinkContext.Provider value={{ openArtifact }}>
      {children}
    </ArtifactLinkContext.Provider>
  );
}
