import { existsSync, statfsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';

import { formatErrorForLog } from '@roomote/types';

type FastAgentStorageExhaustionKind =
  | 'bytes_and_inodes_exhausted'
  | 'bytes_exhausted'
  | 'inodes_exhausted'
  | 'quota_or_limit'
  | 'unknown';

type FastAgentStorageDiagnostic = {
  affectedPath: string;
  filesystemPath: string;
  syscall?: string;
  availableBytes?: bigint;
  availableInodes?: bigint;
  totalInodes?: bigint;
  kind: FastAgentStorageExhaustionKind;
};

export function isFastAgentStorageFullError(error: unknown): boolean {
  const detail = formatErrorForLog(error).toLowerCase();
  return (
    detail.includes('enospc') || detail.includes('no space left on device')
  );
}

export function classifyFastAgentStorageExhaustion(input: {
  availableBytes: bigint;
  availableInodes: bigint;
  totalInodes: bigint;
}): FastAgentStorageExhaustionKind {
  const bytesExhausted = input.availableBytes === 0n;
  // Some overlay and sandbox filesystems report 0/0 when inode accounting is
  // unavailable. Only a real nonzero inode pool can be exhausted.
  const inodesExhausted =
    input.totalInodes > 0n && input.availableInodes === 0n;
  if (bytesExhausted && inodesExhausted) return 'bytes_and_inodes_exhausted';
  if (bytesExhausted) return 'bytes_exhausted';
  if (inodesExhausted) return 'inodes_exhausted';
  return 'quota_or_limit';
}

function findErrorStringField(
  error: unknown,
  field: 'path' | 'syscall',
): string | undefined {
  const seen = new Set<unknown>();
  let current = error;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    const value = (current as Error & Record<string, unknown>)[field];
    if (typeof value === 'string' && value.trim()) return value;
    current = current.cause;
  }
  return undefined;
}

function findExistingFilesystemPath(path: string): string {
  let current = path;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return tmpdir();
    current = parent;
  }
  return current;
}

export function inspectFastAgentStorageFullError(
  error: unknown,
): FastAgentStorageDiagnostic {
  const affectedPath = findErrorStringField(error, 'path') ?? tmpdir();
  const filesystemPath = findExistingFilesystemPath(affectedPath);
  const syscall = findErrorStringField(error, 'syscall');

  try {
    const stats = statfsSync(filesystemPath, { bigint: true });
    const availableBytes = stats.bavail * stats.bsize;
    const availableInodes = stats.ffree;
    const totalInodes = stats.files;
    return {
      affectedPath,
      filesystemPath,
      ...(syscall ? { syscall } : {}),
      availableBytes,
      availableInodes,
      totalInodes,
      kind: classifyFastAgentStorageExhaustion({
        availableBytes,
        availableInodes,
        totalInodes,
      }),
    };
  } catch {
    return {
      affectedPath,
      filesystemPath,
      ...(syscall ? { syscall } : {}),
      kind: 'unknown',
    };
  }
}

export function formatFastAgentStorageFullMessage(
  kind: FastAgentStorageExhaustionKind,
): string {
  if (kind === 'inodes_exhausted') {
    return "Fast's local working filesystem has no free file entries. Ask a deployment administrator to clean up container storage, then try again.";
  }
  if (kind === 'bytes_exhausted' || kind === 'bytes_and_inodes_exhausted') {
    return "Fast's local working filesystem is out of space. Ask a deployment administrator to clean up container storage, then try again.";
  }
  return "Fast's local working storage hit a container or filesystem limit. Ask a deployment administrator to check the container's storage and temporary-filesystem quotas, then try again.";
}

export function wrapFastAgentStorageFullError(
  error: unknown,
  diagnostic: FastAgentStorageDiagnostic,
): Error {
  const fields = [
    `kind=${diagnostic.kind}`,
    `affectedPath=${diagnostic.affectedPath}`,
    `filesystemPath=${diagnostic.filesystemPath}`,
    diagnostic.syscall ? `syscall=${diagnostic.syscall}` : undefined,
    diagnostic.availableBytes === undefined
      ? undefined
      : `availableBytes=${diagnostic.availableBytes}`,
    diagnostic.availableInodes === undefined
      ? undefined
      : `availableInodes=${diagnostic.availableInodes}`,
    diagnostic.totalInodes === undefined
      ? undefined
      : `totalInodes=${diagnostic.totalInodes}`,
  ].filter((field): field is string => Boolean(field));
  return new Error(`Fast local storage exhausted (${fields.join(' ')}).`, {
    cause: error,
  });
}
