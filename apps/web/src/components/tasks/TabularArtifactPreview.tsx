'use client';

import { useMemo } from 'react';

import { useArtifactByPath } from '@/hooks/use-artifact-by-path';
import { getTabularArtifactFormat } from '@/lib/artifact-types';
import { parseTabularArtifact } from '@/lib/tabular-artifacts';
import { cn } from '@/lib/utils';

const THUMBNAIL_ROWS = 6;
const THUMBNAIL_COLUMNS = 5;
const FALLBACK_ROWS = 5;
const FALLBACK_COLUMNS = 4;

type CellLength = 'empty' | 'short' | 'medium' | 'long';

function getCellLength(value: string): CellLength {
  const length = value.trim().length;
  if (length === 0) return 'empty';
  if (length <= 4) return 'short';
  if (length <= 12) return 'medium';
  return 'long';
}

type TabularArtifactPreviewProps = {
  owner: { taskId: string } | { sessionId: string };
  path: string;
  version: number;
  className?: string;
};

export function TabularArtifactPreview({
  owner,
  path,
  version,
  className,
}: TabularArtifactPreviewProps) {
  const { data: artifact, isPending } = useArtifactByPath(
    owner,
    path,
    version,
    'preview',
  );
  const matchingArtifact =
    artifact?.path === path && artifact.version === version
      ? artifact
      : undefined;
  const format = matchingArtifact
    ? getTabularArtifactFormat(matchingArtifact.contentType, path)
    : null;
  const preview = useMemo(
    () =>
      matchingArtifact?.content !== undefined && format
        ? parseTabularArtifact(matchingArtifact.content, format)
        : null,
    [format, matchingArtifact?.content],
  );
  const hasRows = !!preview?.rows.length && preview.columnCount > 0;
  const columnCount = hasRows
    ? Math.min(preview.columnCount, THUMBNAIL_COLUMNS)
    : FALLBACK_COLUMNS;
  const cells = hasRows
    ? preview.rows
        .slice(0, THUMBNAIL_ROWS)
        .flatMap((row) =>
          Array.from({ length: columnCount }, (_, index) =>
            getCellLength(row[index] ?? ''),
          ),
        )
    : Array.from({ length: FALLBACK_ROWS * FALLBACK_COLUMNS }, (_, index) =>
        index % 3 === 0 ? 'short' : index % 3 === 1 ? 'long' : 'medium',
      );

  return (
    <span
      aria-hidden="true"
      className={cn('artifact-paper-preview', className)}
    >
      <span className="artifact-paper-shadow" />
      <span className="artifact-paper">
        <span
          className={cn('tabular-artifact-grid', isPending && 'animate-pulse')}
          data-state={isPending ? 'loading' : hasRows ? 'ready' : 'unavailable'}
          style={{
            gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))`,
          }}
        >
          {cells.map((length, index) => (
            <span
              className="tabular-artifact-cell"
              data-length={length}
              key={index}
            >
              <span className="tabular-artifact-bar" />
            </span>
          ))}
        </span>
      </span>
    </span>
  );
}
