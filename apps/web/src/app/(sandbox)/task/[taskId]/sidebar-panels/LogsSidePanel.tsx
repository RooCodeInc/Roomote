'use client';

import { useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';

import {
  BasicTooltip,
  Button,
  ChevronDown,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
  Logs,
  Trash2,
} from '@/components/system';

import { useLogFiles, useMultiplexedTailLogs } from '../hooks';

import { SidePanelHeader } from './SidePanelHeader';

const TaskLogViewer = dynamic(
  () => import('./TaskLogViewer').then((mod) => mod.TaskLogViewer),
  {
    ssr: false,
    loading: () => (
      <div className="flex flex-1 items-center justify-center bg-zinc-800 px-4 text-sm text-slate-400">
        Loading log viewer...
      </div>
    ),
  },
);

interface LogsSidePanelProps {
  active: boolean;
  onClose: () => void;
}

function getLogfileName(filePath: string) {
  return filePath.split('/').pop() ?? filePath;
}

function getLogfileDisplayLabel(logfile: {
  label: string;
  filePath: string;
}): string {
  return logfile.label || getLogfileName(logfile.filePath);
}

export function LogsSidePanel({ active, onClose }: LogsSidePanelProps) {
  const logfiles = useLogFiles();
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [hasOpenedViewer, setHasOpenedViewer] = useState(active);

  // Tail only the selected file so environments with many setup commands do not
  // exhaust the multiplexed tail path limit while still showing full listings.
  const selectedFilePaths = useMemo(
    () => (selectedFilePath ? [selectedFilePath] : []),
    [selectedFilePath],
  );

  const tailLogs = useMultiplexedTailLogs(active ? selectedFilePaths : []);

  useEffect(() => {
    if (active) {
      setHasOpenedViewer(true);
    }
  }, [active]);

  useEffect(() => {
    if (logfiles.length === 0) {
      setSelectedFilePath(null);
      return;
    }

    setSelectedFilePath((current) => {
      if (current && logfiles.some((logfile) => logfile.filePath === current)) {
        return current;
      }

      return logfiles[0]?.filePath ?? null;
    });
  }, [logfiles]);

  const selectedLogfile = useMemo(
    () =>
      selectedFilePath
        ? (logfiles.find((logfile) => logfile.filePath === selectedFilePath) ??
          null)
        : null,
    [logfiles, selectedFilePath],
  );

  const selectedLines = selectedLogfile
    ? tailLogs.getLines(selectedLogfile.filePath)
    : [];

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background">
      <SidePanelHeader
        onClose={onClose}
        actions={
          selectedLogfile ? (
            <BasicTooltip content="Clear logs">
              <Button
                variant="ghost"
                size="icon"
                className="size-8"
                onClick={() => tailLogs.clear(selectedLogfile.filePath)}
              >
                <Trash2 className="size-4" />
              </Button>
            </BasicTooltip>
          ) : null
        }
        titleAdornment={
          selectedLogfile ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  className="h-7 gap-1.5 px-2 text-sm font-medium hover:text-accent-foreground relative -left-2"
                >
                  <span className="max-w-48 truncate">
                    {getLogfileDisplayLabel(selectedLogfile)}
                  </span>
                  <ChevronDown className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="max-h-80">
                <DropdownMenuLabel>Logs in this environment</DropdownMenuLabel>
                {logfiles.map((logfile) => (
                  <DropdownMenuItem
                    key={logfile.filePath}
                    className="cursor-pointer text-xs"
                    onClick={() => setSelectedFilePath(logfile.filePath)}
                  >
                    <span className="flex flex-col">
                      <span>{getLogfileDisplayLabel(logfile)}</span>
                    </span>
                    {selectedLogfile.filePath === logfile.filePath ? (
                      <span className="ml-auto text-muted-foreground">
                        &bull;
                      </span>
                    ) : null}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : logfiles.length === 1 ? (
            <span className="flex h-6 items-center gap-1 px-2 text-xs font-medium text-muted-foreground">
              <Logs className="size-3" />
              <span className="max-w-24 truncate">
                {getLogfileDisplayLabel(logfiles[0]!)}
              </span>
            </span>
          ) : null
        }
      />

      {selectedLogfile ? (
        <div className="ph-no-capture flex min-h-0 flex-1 flex-col overflow-hidden border-t border-border/60">
          {hasOpenedViewer ? (
            <TaskLogViewer
              key={selectedLogfile.filePath}
              lines={selectedLines}
              error={tailLogs.error}
            />
          ) : (
            <div className="flex flex-1 items-center justify-center bg-zinc-800 px-4 text-sm text-slate-400">
              Open the logs tab to inspect environment output.
            </div>
          )}
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
          No log files are available for this task yet.
        </div>
      )}
    </div>
  );
}
