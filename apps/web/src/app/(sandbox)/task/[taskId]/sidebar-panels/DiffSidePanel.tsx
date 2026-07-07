'use client';

import { useCallback, useEffect, useMemo, useRef } from 'react';

import { Button } from '@/components/system';

import { SidePanelHeader } from './SidePanelHeader';

import { DiffSkeleton } from './diff/DiffSkeleton';
import { EmptyState } from './diff/EmptyState';
import { FileDiffBlock } from './diff/FileDiffBlock';
import { FileNav } from './diff/FileNav';
import { fileId } from './diff/utils';
import type { GitDiffResponse } from '../hooks';

const INITIAL_VISIBLE_DIFF_BLOCKS = 8;

interface DiffSidePanelProps {
  data: GitDiffResponse | undefined;
  error: Error | null;
  isLoading: boolean;
  onRefresh: () => void;
  onClose: () => void;
}

export function DiffSidePanel({
  data,
  error,
  isLoading,
  onRefresh,
  onClose,
}: DiffSidePanelProps) {
  const diffScrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        onClose();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const repos = useMemo(
    () => (data?.repos ?? []).filter((repo) => repo.files.length > 0),
    [data?.repos],
  );
  const totalFiles = useMemo(
    () => repos.reduce((count, repo) => count + repo.files.length, 0),
    [repos],
  );
  const repoSections = useMemo(() => {
    let fileIndex = 0;

    return repos.map((repo) => ({
      repoName: repo.repoName,
      files: repo.files.map((file) => ({
        file,
        fileIndex: fileIndex++,
      })),
    }));
  }, [repos]);

  const scrollToFile = useCallback((repoName: string, path: string) => {
    const el = document.getElementById(fileId(repoName, path));
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, []);

  const content = (() => {
    if (isLoading) {
      return <DiffSkeleton />;
    }

    if (error) {
      return (
        <>
          <p className="text-sm text-muted-foreground">Failed to load diff</p>
          <p className="text-xs text-muted-foreground opacity-60">
            {error.message}
          </p>
          <Button
            variant="link"
            size="sm"
            onClick={onRefresh}
            className="mt-2 h-auto p-0 text-xs text-muted-foreground"
          >
            Retry
          </Button>
        </>
      );
    }

    if (totalFiles === 0) {
      return <EmptyState />;
    }

    const hasMultipleRepos = repos.length > 1;

    return (
      <div className="relative flex h-full min-h-0 min-w-0 flex-1 gap-4 overflow-hidden">
        <FileNav repos={repos} onSelect={scrollToFile} />
        <div
          ref={diffScrollRef}
          className="min-h-0 min-w-0 flex-1 space-y-4 overflow-y-auto overflow-x-hidden pb-4 pr-1 scroll-thin scroll-pt-4"
        >
          {repoSections.map((repo) => (
            <div key={repo.repoName} className="space-y-4">
              {hasMultipleRepos && (
                <h3 className="pt-2 text-sm font-semibold">
                  {repo.repoName} repository
                </h3>
              )}
              {repo.files.map(({ file, fileIndex }) => (
                <FileDiffBlock
                  key={file.path}
                  file={file}
                  id={fileId(repo.repoName, file.path)}
                  rootRef={diffScrollRef}
                  defaultVisible={fileIndex < INITIAL_VISIBLE_DIFF_BLOCKS}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
    );
  })();

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <SidePanelHeader title="Files changed" onClose={onClose} />
      <div className="@container h-full min-h-0 flex-1 w-full overflow-hidden p-3">
        {content}
      </div>
    </div>
  );
}
