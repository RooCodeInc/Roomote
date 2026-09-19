'use client';

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { format as formatDate } from 'date-fns';

import {
  Maximize2,
  ChevronDown,
  Check,
  Button,
  BasicTooltip,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuLabel,
  X,
} from '@/components/system';

import type { ArtifactWithContent } from '@/types';

import { useTRPC } from '@/trpc/client';

import { ArtifactViewerContent } from '@/components/tasks/ArtifactViewerContent';

import { useTaskSidePanel } from '../../hooks';
import { SidePanelHeader } from '../SidePanelHeader';

interface ArtifactDetailProps {
  artifact: ArtifactWithContent | null;
  isLoading: boolean;
  taskId: string;
  isActive: boolean;
}

function formatArtifactVersionDate(
  createdAt: Date | string | number | null | undefined,
): string {
  if (!createdAt) {
    return 'Unknown date';
  }

  const date = createdAt instanceof Date ? createdAt : new Date(createdAt);

  return Number.isFinite(date.getTime())
    ? formatDate(date, 'MMM d, yyyy, H:mm:ss')
    : 'Unknown date';
}

export function ArtifactDetail({
  artifact,
  isLoading,
  taskId,
  isActive,
}: ArtifactDetailProps) {
  const [isFullscreenOpen, setIsFullscreenOpen] = useState(false);
  const [firstRowIsHeader, setFirstRowIsHeader] = useState(false);

  const trpc = useTRPC();
  const {
    closeSidePanel,
    goBackToArtifactsBrowser,
    goToPreviousArtifact,
    goToNextArtifact,
    canGoToPreviousArtifact,
    canGoToNextArtifact,
    setArtifactVersion,
    selectedArtifactPath,
  } = useTaskSidePanel();

  const { data: versions = [] } = useQuery({
    ...trpc.artifacts.versions.queryOptions({
      taskId,
      path: artifact?.path || '',
    }),
    enabled: !!artifact,
    refetchInterval: artifact ? 3000 : false,
  });

  const hasMultipleVersions = versions.length > 1;

  useEffect(() => {
    setFirstRowIsHeader(false);
  }, [artifact?.path, artifact?.version]);

  useEffect(() => {
    if (!isFullscreenOpen) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        setIsFullscreenOpen(false);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [isFullscreenOpen]);

  return (
    <>
      <SidePanelHeader
        title={
          isLoading ? (selectedArtifactPath ?? 'Loading…') : artifact?.path
        }
        onClose={closeSidePanel}
        onBack={goBackToArtifactsBrowser}
        titleAdornment={
          <>
            {hasMultipleVersions && artifact && !isLoading && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    className="h-7 gap-1.5 px-2 text-sm font-medium hover:text-accent-foreground relative -left-2"
                  >
                    v{artifact.version}
                    <ChevronDown className="size-3" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuLabel>Artifact versions</DropdownMenuLabel>
                  {versions.map((version) => (
                    <DropdownMenuItem
                      key={version.id}
                      onClick={() => setArtifactVersion(version.version)}
                      className="flex items-center justify-between gap-4"
                    >
                      <span className="flex items-center gap-2">
                        <span>Version {version.version}</span>
                        <span className="mr-4 text-xs text-muted-foreground">
                          {formatArtifactVersionDate(version.createdAt)}
                        </span>
                        {version.version === artifact.version && (
                          <Check className="size-3 text-primary" />
                        )}
                      </span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </>
        }
        actions={
          <>
            <BasicTooltip content="View fullscreen">
              <Button
                variant="ghost"
                size="icon"
                className="size-5 shrink-0 hover:scale-120 hover:text-accent-foreground"
                disabled={!artifact || isLoading}
                onClick={() => setIsFullscreenOpen(true)}
              >
                <Maximize2 className="size-3.5" />
              </Button>
            </BasicTooltip>
          </>
        }
      />
      <div className="min-h-0 flex-1 bg-background">
        {!isFullscreenOpen ? (
          <ArtifactViewerContent
            artifact={artifact}
            owner={{ taskId }}
            onVersionChange={setArtifactVersion}
            className="h-full border-0"
            isLoading={isLoading}
            firstRowIsHeader={firstRowIsHeader}
            onFirstRowIsHeaderChange={setFirstRowIsHeader}
            onPreviousArtifact={
              canGoToPreviousArtifact ? goToPreviousArtifact : undefined
            }
            onNextArtifact={canGoToNextArtifact ? goToNextArtifact : undefined}
            navigationActive={isActive}
          />
        ) : null}
      </div>
      {isFullscreenOpen && artifact && (
        <div className="fixed inset-0 z-dialog flex items-center justify-center bg-black/75 p-4">
          <div className="relative h-[90vh] w-[90vw] overflow-hidden rounded-lg border bg-background shadow-2xl">
            <Button
              variant="ghost"
              size="icon"
              className="absolute right-2 top-2 z-10 size-8"
              onClick={() => setIsFullscreenOpen(false)}
            >
              <X className="size-4" />
            </Button>
            <ArtifactViewerContent
              artifact={artifact}
              owner={{ taskId }}
              onVersionChange={setArtifactVersion}
              className="h-full border-0"
              firstRowIsHeader={firstRowIsHeader}
              showToolbar={false}
              onPreviousArtifact={
                canGoToPreviousArtifact ? goToPreviousArtifact : undefined
              }
              onNextArtifact={
                canGoToNextArtifact ? goToNextArtifact : undefined
              }
              navigationActive={isActive}
            />
          </div>
        </div>
      )}
    </>
  );
}
