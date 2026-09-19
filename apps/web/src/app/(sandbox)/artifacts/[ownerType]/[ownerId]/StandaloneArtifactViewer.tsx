'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';

import { humanizeFilename } from '@/lib/task-utils';
import {
  getArtifactViewUrl,
  getSessionArtifactViewUrl,
  getStandaloneArtifactViewUrl,
  type ArtifactViewOwner,
} from '@/lib/artifact-view-urls';
import { useArtifactByPath } from '@/hooks/use-artifact-by-path';
import { usePageTitle } from '@/hooks/usePageTitle';
import { ArtifactViewerContent } from '@/components/tasks/ArtifactViewerContent';
import { ArrowUpRightIcon, Button } from '@/components/system';

export function StandaloneArtifactViewer({
  owner,
  path,
  version,
}: {
  owner: ArtifactViewOwner;
  path: string | null;
  version?: number;
}) {
  const router = useRouter();
  const {
    data: artifact,
    isPending,
    isError,
  } = useArtifactByPath(owner, path, version);
  const selectedArtifact =
    artifact?.path === path &&
    (version === undefined || artifact.version === version)
      ? artifact
      : null;
  const title = path ? humanizeFilename(path) : 'Artifact';
  const sourceUrl =
    path && selectedArtifact
      ? 'taskId' in owner
        ? getArtifactViewUrl('', owner.taskId, path, selectedArtifact.version)
        : getSessionArtifactViewUrl(
            '',
            owner.sessionId,
            path,
            selectedArtifact.version,
          )
      : null;
  const isLoading = !!path && isPending;
  const emptyMessage = !path
    ? 'This artifact link is missing a file path.'
    : isError || (!isPending && !selectedArtifact)
      ? 'This artifact is unavailable.'
      : undefined;

  usePageTitle(title);

  const handleVersionChange = (nextVersion: number) => {
    if (!path) return;
    router.replace(getStandaloneArtifactViewUrl('', owner, path, nextVersion));
  };

  return (
    <main className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background">
      <header className="flex min-w-0 flex-wrap items-center gap-3 border-b px-4 py-3 sm:px-6">
        <div className="min-w-0 flex-1">
          <h1
            className="truncate text-sm font-medium"
            title={path ?? undefined}
          >
            {title}
          </h1>
          {selectedArtifact ? (
            <p className="text-xs text-muted-foreground">
              Version {selectedArtifact.version}
            </p>
          ) : null}
        </div>
        {sourceUrl ? (
          <Button asChild variant="outline" size="sm">
            <Link href={sourceUrl}>
              Open source {'taskId' in owner ? 'task' : 'session'}
              <ArrowUpRightIcon />
            </Link>
          </Button>
        ) : null}
      </header>
      <div className="min-h-0 flex-1">
        <ArtifactViewerContent
          artifact={selectedArtifact}
          owner={owner}
          className="h-full border-0"
          isLoading={isLoading}
          emptyMessage={emptyMessage}
          onVersionChange={handleVersionChange}
        />
      </div>
    </main>
  );
}
