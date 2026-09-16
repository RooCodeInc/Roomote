'use client';

import { useMemo } from 'react';

import { useArtifactByPath } from '@/hooks/use-artifact-by-path';
import { getTabularArtifactFormat } from '@/lib/artifact-types';
import { parseTabularArtifact } from '@/lib/tabular-artifacts';
import { cn } from '@/lib/utils';

const THUMBNAIL_ROWS = 6;
const THUMBNAIL_COLUMNS = 8;
const THUMBNAIL_CELL_CHARACTERS = 24;
const FALLBACK_ROWS = 5;
const FALLBACK_COLUMNS = 4;

function getThumbnailCell(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= THUMBNAIL_CELL_CHARACTERS) return normalized;
  return `${normalized.slice(0, THUMBNAIL_CELL_CHARACTERS - 3)}...`;
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
  const rows = hasRows
    ? preview.rows
        .slice(0, THUMBNAIL_ROWS)
        .map((row) =>
          Array.from({ length: columnCount }, (_, index) =>
            getThumbnailCell(row[index] ?? ''),
          ),
        )
    : [];

  return (
    <span
      aria-hidden="true"
      className={cn('artifact-paper-preview', className)}
    >
      <span className="artifact-paper-shadow" />
      <span className="artifact-paper">
        {hasRows ? (
          <span
            className="tabular-artifact-grid"
            data-state="ready"
            style={{
              gridTemplateColumns: `repeat(${columnCount}, 4rem)`,
            }}
          >
            {rows.flatMap((row, rowIndex) =>
              row.map((cell, columnIndex) => (
                <span
                  className="tabular-artifact-cell"
                  data-first-row={rowIndex === 0}
                  key={`${rowIndex}-${columnIndex}`}
                >
                  {cell}
                </span>
              )),
            )}
          </span>
        ) : (
          <span
            className={cn(
              'tabular-artifact-placeholder',
              isPending && 'animate-pulse',
            )}
            data-state={isPending ? 'loading' : 'unavailable'}
          >
            {Array.from(
              { length: FALLBACK_ROWS * FALLBACK_COLUMNS },
              (_, index) => (
                <span key={index}>
                  <span />
                </span>
              ),
            )}
          </span>
        )}
      </span>
    </span>
  );
}
