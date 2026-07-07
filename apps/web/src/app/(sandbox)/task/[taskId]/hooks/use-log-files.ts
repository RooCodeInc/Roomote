import { useContext, useEffect, useMemo } from 'react';
import { useStore } from 'zustand';

import { useEnvironment } from '@/hooks/environments';

import type { LogfileInfo } from './use-sandbox-store';
import { SandboxStoreContext } from './SandboxProvider';

const EMPTY_LOGFILES: LogfileInfo[] = [];

/**
 * The harness log is always present inside the live sandbox at
 * `/tmp/harness.log`, so it is surfaced as a persistent option in the Logs
 * sidebar regardless of environment config.
 */
const HARNESS_LOG: LogfileInfo = {
  label: 'harness.log',
  filePath: '/tmp/harness.log',
};

/**
 * When called with an `environmentId` and/or `additionalLogfiles`, derives and
 * syncs logfiles into the sandbox store. When called without either, reads from
 * the store.
 */
export function useLogFiles(
  ...args: [environmentId?: string, additionalLogfiles?: LogfileInfo[]]
): LogfileInfo[] {
  const hasSyncInputs = args.length > 0;
  const environmentId = args[0];
  const additionalLogfiles = args[1] ?? EMPTY_LOGFILES;
  const store = useContext(SandboxStoreContext);

  if (!store) {
    throw new Error('useLogFiles must be used within a SandboxProvider');
  }

  const logfiles = useStore(store, (s) => s.logfiles);
  const environment = useEnvironment(environmentId);

  const environmentLogfiles = useMemo<LogfileInfo[]>(() => {
    const config = environment.data?.config;

    if (!config?.repositories) {
      return [];
    }

    const result: LogfileInfo[] = [];

    for (const repo of config.repositories) {
      for (const cmd of repo.commands ?? []) {
        if (cmd.logfile) {
          result.push({ label: cmd.name, filePath: cmd.logfile });
        }
      }
    }

    return result;
  }, [environment.data?.config]);

  const mergedLogfiles = useMemo(
    () =>
      mergeLogFiles([HARNESS_LOG, ...environmentLogfiles], additionalLogfiles),
    [environmentLogfiles, additionalLogfiles],
  );

  useEffect(() => {
    if (hasSyncInputs) {
      store.getState().setLogfiles(mergedLogfiles);
    }
  }, [hasSyncInputs, mergedLogfiles, store]);

  return logfiles;
}

function mergeLogFiles(
  environmentLogfiles: LogfileInfo[],
  additionalLogfiles: LogfileInfo[],
): LogfileInfo[] {
  const seen = new Set<string>();
  const merged: LogfileInfo[] = [];

  for (const logfile of [...environmentLogfiles, ...additionalLogfiles]) {
    if (seen.has(logfile.filePath)) {
      continue;
    }

    seen.add(logfile.filePath);
    merged.push(logfile);
  }

  return merged;
}
