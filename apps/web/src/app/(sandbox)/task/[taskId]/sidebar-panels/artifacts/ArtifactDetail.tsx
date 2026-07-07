'use client';

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { format as formatDate } from 'date-fns';

import {
  ChevronLeftIcon,
  ChevronRight,
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
  Loader2Icon,
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
}: ArtifactDetailProps) {
  const [isFullscreenOpen, setIsFullscreenOpen] = useState(false);

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
            <BasicTooltip content="Previous artifact">
              <Button
                variant="ghost"
                size="icon"
                className="size-5 shrink-0 hover:scale-120 hover:text-accent-foreground"
                disabled={!canGoToPreviousArtifact}
                onClick={goToPreviousArtifact}
              >
                <ChevronLeftIcon className="size-3.5" />
              </Button>
            </BasicTooltip>
            <BasicTooltip content="Next artifact">
              <Button
                variant="ghost"
                size="icon"
                className="size-5 shrink-0 hover:scale-120 hover:text-accent-foreground"
                disabled={!canGoToNextArtifact}
                onClick={goToNextArtifact}
              >
                <ChevronRight className="size-3.5" />
              </Button>
            </BasicTooltip>
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
      <div className="min-h-0 flex-1 bg-zinc-800">
        {isLoading ? (
          <div className="flex h-full items-center justify-center">
            <Loader2Icon className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : !isFullscreenOpen ? (
          <ArtifactViewerContent
            artifact={artifact}
            taskId={taskId}
            onVersionChange={setArtifactVersion}
            className="h-full border-0"
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
              taskId={taskId}
              onVersionChange={setArtifactVersion}
              className="h-full border-0"
              showToolbar={false}
            />
          </div>
        </div>
      )}
    </>
  );
}
