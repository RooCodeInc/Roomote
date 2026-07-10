'use client';

import { useMemo } from 'react';
import { Image, FileText, VideoIcon } from '@/components/system';

import { humanizeFilename } from '@/lib';

import type { TaskSession, TaskArtifact } from '../../hooks';
import type { ArtifactGroup } from '../../sidebar-actions/types';
import { useTaskSidePanel } from '../../hooks';
import { groupArtifactsByPath } from '../../sidebar-actions/utils';
import { SidePanelHeader } from '../SidePanelHeader';

interface ArtifactListProps {
  session: TaskSession;
}

function isScreenshotGroup(group: ArtifactGroup<TaskArtifact>): boolean {
  return group.latest.contentType.startsWith('image/');
}

function isVideoGroup(group: ArtifactGroup<TaskArtifact>): boolean {
  return group.latest.contentType.startsWith('video/');
}

export function ArtifactList({ session }: ArtifactListProps) {
  const { openArtifactDetail, closeSidePanel } = useTaskSidePanel();

  const artifactGroups = useMemo(
    () => groupArtifactsByPath(session.artifacts),
    [session.artifacts],
  );

  const screenshotGroups = useMemo(
    () => artifactGroups.filter(isScreenshotGroup),
    [artifactGroups],
  );

  const otherGroups = useMemo(
    () =>
      artifactGroups.filter((g) => !isScreenshotGroup(g) && !isVideoGroup(g)),
    [artifactGroups],
  );

  const videoGroups = useMemo(
    () => artifactGroups.filter(isVideoGroup),
    [artifactGroups],
  );

  return (
    <>
      <SidePanelHeader title="Artifacts" onClose={closeSidePanel} />
      <div className="flex-1 overflow-y-auto px-2 py-2 scroll-thin">
        {artifactGroups.length === 0 ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
            No artifacts in this task yet.
          </div>
        ) : (
          <>
            {screenshotGroups.length > 0 && (
              <div className="px-1 pb-2 @container">
                <h3 className="px-2 pb-2 pt-1 text-xs font-medium text-muted-foreground">
                  Screenshots
                </h3>
                <div className="grid grid-cols-2 @[500px]:grid-cols-3 gap-4">
                  {screenshotGroups.map((group) => (
                    <button
                      key={group.path}
                      type="button"
                      onClick={() =>
                        openArtifactDetail(
                          group.latest.path,
                          group.latest.version,
                        )
                      }
                      className="group relative overflow-hidden rounded-lg border bg-card hover:opacity-70 cursor-pointer transition-opacity"
                    >
                      {group.latest.thumbnailUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={group.latest.thumbnailUrl}
                          alt={humanizeFilename(group.latest.path)}
                          className="aspect-video w-full object-contain rounded-md m-2"
                          loading="lazy"
                        />
                      ) : (
                        <div className="flex aspect-video w-full items-center justify-center">
                          <Image className="size-6 text-muted-foreground" />
                        </div>
                      )}
                      <div className="px-2 py-1.5 border-t">
                        <span className="block truncate text-xs font-medium">
                          {humanizeFilename(group.latest.path)}
                          {group.olderVersions.length > 0
                            ? ` (v${group.latest.version})`
                            : ''}
                        </span>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {videoGroups.length > 0 && (
              <div className="px-1 pb-2 @container">
                <h3 className="px-2 pb-2 pt-1 text-xs font-medium text-muted-foreground">
                  Videos
                </h3>
                <div className="grid grid-cols-2 @[500px]:grid-cols-3 gap-4">
                  {videoGroups.map((group) => (
                    <button
                      key={group.path}
                      type="button"
                      onClick={() =>
                        openArtifactDetail(
                          group.latest.path,
                          group.latest.version,
                        )
                      }
                      className="group relative overflow-hidden rounded-lg border bg-card hover:opacity-70 cursor-pointer transition-opacity"
                    >
                      {group.latest.previewUrl ? (
                        <div className="relative">
                          <video
                            src={group.latest.previewUrl}
                            muted
                            playsInline
                            preload="metadata"
                            className="pointer-events-none aspect-video w-full rounded-md object-contain bg-black"
                          />
                          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                            <div className="flex size-8 items-center justify-center rounded-full bg-black/60 ring-1 ring-white/25">
                              <span className="ml-0.5 h-0 w-0 border-y-[5px] border-y-transparent border-l-[8px] border-l-white" />
                            </div>
                          </div>
                        </div>
                      ) : (
                        <div className="flex aspect-video w-full items-center justify-center">
                          <VideoIcon className="size-6 text-muted-foreground" />
                        </div>
                      )}
                      <div className="px-2 py-1.5 border-t">
                        <span className="block truncate text-xs font-medium">
                          {humanizeFilename(group.latest.path)}
                          {group.olderVersions.length > 0
                            ? ` (v${group.latest.version})`
                            : ''}
                        </span>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {otherGroups.length > 0 && (
              <div>
                {(screenshotGroups.length > 0 || videoGroups.length > 0) && (
                  <h3 className="px-3 pb-1 pt-2 text-xs font-medium text-muted-foreground">
                    Files
                  </h3>
                )}
                {otherGroups.map((group) => (
                  <button
                    key={group.path}
                    type="button"
                    onClick={() =>
                      openArtifactDetail(
                        group.latest.path,
                        group.latest.version,
                      )
                    }
                    className="flex w-full items-start gap-3 rounded-lg px-3 py-3 text-left hover:opacity-70 transition-opacity cursor-pointer"
                  >
                    <FileText className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-sm font-medium">
                        {humanizeFilename(group.latest.path)}
                        {group.olderVersions.length > 0
                          ? ` (v${group.latest.version})`
                          : ''}
                      </span>
                      <span className="truncate font-mono text-xs text-muted-foreground">
                        {group.latest.path}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}
