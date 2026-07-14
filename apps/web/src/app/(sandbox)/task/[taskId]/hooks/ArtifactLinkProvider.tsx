'use client';

import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useMemo,
} from 'react';

import type { TaskArtifact } from '@/types';

import type { TaskSession } from './use-task-session';

import { useTaskSidePanel } from './use-task-side-panel';

interface ArtifactLinkContextType {
  openArtifact: (path: string, version?: number) => void;
  getArtifactById: (artifactId: string) => TaskArtifact | undefined;
  artifacts: readonly TaskArtifact[];
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
  session,
  children,
}: ArtifactLinkProviderProps) {
  const { openArtifactDetail } = useTaskSidePanel();

  const openArtifact = useCallback(
    (path: string, version?: number) => {
      openArtifactDetail(path, version);
    },
    [openArtifactDetail],
  );

  const artifacts = session.artifacts ?? [];

  const getArtifactById = useCallback(
    (artifactId: string) =>
      artifacts.find((artifact) => artifact.id === artifactId),
    [artifacts],
  );

  const value = useMemo(
    () => ({
      openArtifact,
      getArtifactById,
      artifacts,
    }),
    [openArtifact, getArtifactById, artifacts],
  );

  return (
    <ArtifactLinkContext.Provider value={value}>
      {children}
    </ArtifactLinkContext.Provider>
  );
}
