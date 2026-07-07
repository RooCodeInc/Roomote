'use client';

import { useMemo } from 'react';

import { cn } from '@/lib/utils';

import type { CloudSession } from '../hooks';
import { useArtifactByPath, useTaskSidePanel } from '../hooks';
import { ArtifactList } from './artifacts/ArtifactList';
import { ArtifactDetail } from './artifacts/ArtifactDetail';

interface ArtifactsSidePanelProps {
  session: CloudSession;
}

export function ArtifactsSidePanel({ session }: ArtifactsSidePanelProps) {
  const { artifactsMode, selectedArtifactPath, selectedArtifactVersion } =
    useTaskSidePanel();

  const resolvedVersion = useMemo(
    () =>
      selectedArtifactVersion ??
      session.artifacts
        .filter((artifact) => artifact.path === selectedArtifactPath)
        .reduce<
          number | undefined
        >((maxVersion, artifact) => (maxVersion === undefined || artifact.version > maxVersion ? artifact.version : maxVersion), undefined),
    [selectedArtifactPath, selectedArtifactVersion, session.artifacts],
  );

  const { data: artifact, isPending: isArtifactPending } = useArtifactByPath(
    session.taskId,
    selectedArtifactPath,
    resolvedVersion,
  );

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background">
      <div
        className={cn(
          'h-full min-h-0 min-w-0 flex-1 flex-col',
          artifactsMode === 'browser' ? 'flex' : 'hidden',
        )}
      >
        <ArtifactList session={session} />
      </div>

      <div
        className={cn(
          'h-full min-h-0 min-w-0 flex-1 flex-col',
          artifactsMode === 'detail' ? 'flex' : 'hidden',
        )}
      >
        <ArtifactDetail
          artifact={artifact ?? null}
          isLoading={artifactsMode === 'detail' && isArtifactPending}
          taskId={session.taskId}
        />
      </div>
    </div>
  );
}
