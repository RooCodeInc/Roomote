'use client';

import { useEffect, useRef } from 'react';
import { LazyLog, ScrollFollow } from '@melloware/react-logviewer';

interface TaskLogViewerProps {
  lines: string[];
  error: string | null;
}

export function TaskLogViewer({ lines, error }: TaskLogViewerProps) {
  const viewerRef = useRef<LazyLog | null>(null);
  const previousLineCountRef = useRef(0);

  useEffect(() => {
    const viewer = viewerRef.current;

    if (!viewer) {
      previousLineCountRef.current = lines.length;
      return;
    }

    if (lines.length === 0) {
      viewer.clear();
      previousLineCountRef.current = 0;
      return;
    }

    if (lines.length < previousLineCountRef.current) {
      viewer.clear();
      viewer.appendLines(lines);
      previousLineCountRef.current = lines.length;
      return;
    }

    if (previousLineCountRef.current === 0) {
      viewer.appendLines(lines);
      previousLineCountRef.current = lines.length;
      return;
    }

    if (lines.length > previousLineCountRef.current) {
      viewer.appendLines(lines.slice(previousLineCountRef.current));
      previousLineCountRef.current = lines.length;
    }
  }, [lines]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-zinc-800 text-slate-100">
      {error ? (
        <div className="border-b border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          {error}
        </div>
      ) : null}

      <div className="relative min-h-0 flex-1 px-2">
        <ScrollFollow
          startFollowing
          render={({ follow, onScroll }) => (
            <LazyLog
              ref={viewerRef}
              external
              caseInsensitive
              enableLinks
              enableLineNumbers={false}
              enableSearch
              enableSearchNavigation={false}
              extraLines={1}
              follow={follow}
              onScroll={onScroll}
              selectableLines
              wrapLines
              style={{
                backgroundColor: '#27272a',
                color: '#e2e8f0',
                height: '100%',
                width: '100%',
              }}
              containerStyle={{
                backgroundColor: '#27272a',
                fontFamily:
                  'var(--font-geist-mono, ui-monospace, SFMono-Regular, monospace)',
                fontSize: '12px',
                lineHeight: '1.5',
              }}
              text=""
            />
          )}
        />

        {lines.length === 0 ? (
          <div className="pointer-events-none absolute inset-x-0 top-16 px-4 text-xs text-slate-400">
            Waiting for log output...
          </div>
        ) : null}
      </div>
    </div>
  );
}
