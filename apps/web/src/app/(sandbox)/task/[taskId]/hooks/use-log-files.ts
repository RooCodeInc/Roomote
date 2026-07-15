import { useContext, useEffect, useMemo, useState } from 'react';
import { useStore } from 'zustand';

import { getDockerProjectLogFilePath } from '@roomote/types';

import { useEnvironment } from '@/hooks/environments';

import type { LogfileInfo } from './use-sandbox-store';
import { SandboxStoreContext, useSandboxClient } from './SandboxProvider';

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

/** Poll while setup is still running so finished command logs appear promptly. */
const SETUP_STATUS_POLL_MS_RUNNING = 2_000;
/** Keep a slower poll after setup settles so late writes still surface. */
const SETUP_STATUS_POLL_MS_SETTLED = 15_000;

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
  const client = useSandboxClient();
  const [setupLogfiles, setSetupLogfiles] =
    useState<LogfileInfo[]>(EMPTY_LOGFILES);

  if (!store) {
    throw new Error('useLogFiles must be used within a SandboxProvider');
  }

  const logfiles = useStore(store, (s) => s.logfiles);
  const environment = useEnvironment(environmentId);

  const environmentLogfiles = useMemo<LogfileInfo[]>(() => {
    const config = environment.data?.config;

    if (!config) {
      return [];
    }

    const result: LogfileInfo[] = [];

    for (const repo of config.repositories ?? []) {
      for (const cmd of repo.commands ?? []) {
        if (cmd.logfile) {
          result.push({ label: cmd.name, filePath: cmd.logfile });
        }
      }
    }

    // The worker streams each Docker project's Compose startup output and a
    // live `docker compose logs --follow` feed into a well-known file.
    for (const project of config.docker_projects ?? []) {
      result.push({
        label: `${project.name} (Docker)`,
        filePath: getDockerProjectLogFilePath(project.name),
      });
    }

    return result;
  }, [environment.data?.config]);

  useEffect(() => {
    if (!hasSyncInputs || !client) {
      setSetupLogfiles(EMPTY_LOGFILES);
      return;
    }

    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      try {
        const result = await client.commands.getSetupStatus.query();

        if (cancelled) {
          return;
        }

        const next = result.status
          ? logfilesFromSetupStatus(result.status.commands)
          : EMPTY_LOGFILES;

        setSetupLogfiles((prev) =>
          areLogfilesEqual(prev, next) ? prev : next,
        );

        const delay =
          result.status?.state === 'running'
            ? SETUP_STATUS_POLL_MS_RUNNING
            : SETUP_STATUS_POLL_MS_SETTLED;

        timeoutId = setTimeout(() => {
          void poll();
        }, delay);
      } catch {
        if (cancelled) {
          return;
        }

        // Sandbox may briefly be unavailable during reconnect; retry gently.
        timeoutId = setTimeout(() => {
          void poll();
        }, SETUP_STATUS_POLL_MS_SETTLED);
      }
    };

    void poll();

    return () => {
      cancelled = true;

      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };
  }, [hasSyncInputs, client]);

  const mergedLogfiles = useMemo(
    () =>
      mergeLogFiles(
        [HARNESS_LOG, ...environmentLogfiles, ...setupLogfiles],
        additionalLogfiles,
      ),
    [environmentLogfiles, setupLogfiles, additionalLogfiles],
  );

  useEffect(() => {
    if (hasSyncInputs) {
      store.getState().setLogfiles(mergedLogfiles);
    }
  }, [hasSyncInputs, mergedLogfiles, store]);

  return logfiles;
}
function logfilesFromSetupStatus(
  commands: Array<{
    repository: string;
    name: string;
    logFile?: string;
  }>,
): LogfileInfo[] {
  const withLogs = commands.filter(
    (command): command is typeof command & { logFile: string } =>
      Boolean(command.logFile),
  );

  const baseLabelCounts = new Map<string, number>();

  for (const command of withLogs) {
    const baseLabel = setupLogBaseLabel(command.name);
    baseLabelCounts.set(baseLabel, (baseLabelCounts.get(baseLabel) ?? 0) + 1);
  }

  return withLogs.map((command) => {
    const baseLabel = setupLogBaseLabel(command.name);
    const needsRepoDisambiguation = (baseLabelCounts.get(baseLabel) ?? 0) > 1;

    return {
      label: needsRepoDisambiguation
        ? `${baseLabel} (${shortRepositoryName(command.repository)})`
        : baseLabel,
      filePath: command.logFile,
    };
  });
}

function setupLogBaseLabel(commandName: string): string {
  return `Setup: ${commandName}`;
}

function shortRepositoryName(repository: string): string {
  return repository.includes('/')
    ? (repository.split('/').pop() ?? repository)
    : repository;
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

function areLogfilesEqual(a: LogfileInfo[], b: LogfileInfo[]): boolean {
  if (a === b) {
    return true;
  }

  if (a.length !== b.length) {
    return false;
  }

  return a.every(
    (logfile, index) =>
      logfile.filePath === b[index]?.filePath &&
      logfile.label === b[index]?.label,
  );
}
