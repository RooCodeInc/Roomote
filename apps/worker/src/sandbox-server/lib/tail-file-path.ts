import path from 'node:path';

/**
 * Validate a path accepted by sandbox log tails.
 *
 * Allowed:
 * - workspace-relative paths (resolved against the sandbox cwd)
 * - absolute paths confined under `/tmp` after normalization — used for
 *   harness.log, Docker project logs, and environment detached `logfile`s
 *
 * Rejected: path traversal, shell metacharacters, and absolute paths outside
 * `/tmp` (which would otherwise let clients read host files via `tail`).
 */
export function assertSafeTailFilePath(filePath: string): void {
  if (!filePath || filePath.trim() === '') {
    throw new Error('Path cannot be empty');
  }

  if (filePath.includes('..')) {
    throw new Error('Path traversal not allowed');
  }

  if (/[;|&$`"'\\<>(){}[\]*?!#~]/.test(filePath)) {
    throw new Error('Invalid characters in path');
  }

  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(filePath)) {
    throw new Error('Control characters not allowed in path');
  }

  if (!path.isAbsolute(filePath)) {
    return;
  }

  // Normalize so `/tmp/../etc/passwd` cannot slip past a simple prefix check.
  const normalized = path.posix.normalize(filePath);

  if (!normalized.startsWith('/tmp/')) {
    throw new Error('Absolute paths outside /tmp are not allowed');
  }
}
