import fs from 'node:fs';
import path from 'node:path';

const TMP_ROOT = '/tmp';

/**
 * Validate a path accepted by sandbox log tails and return the path that
 * should be passed to `tail`.
 *
 * Allowed:
 * - workspace-relative paths (resolved against the sandbox cwd by the tail
 *   process)
 * - absolute paths confined under `/tmp` after realpath resolution — used for
 *   harness.log, Docker project logs, and environment detached `logfile`s
 *
 * For absolute paths, the canonical target must remain under `/tmp` so a
 * symlink such as `/tmp/link -> /etc/passwd` cannot bypass the boundary.
 * When the file does not exist yet (common for followed logfiles), the
 * deepest existing ancestor is realpath'd and remaining segments are
 * re-joined, then re-checked under `/tmp`.
 *
 * Rejected: path traversal, shell metacharacters, and absolute paths outside
 * `/tmp` (which would otherwise let clients read host files via `tail`).
 */
export function resolveSafeTailFilePath(filePath: string): string {
  assertCommonPathRules(filePath);

  if (!path.isAbsolute(filePath)) {
    return filePath;
  }

  // Normalize so `/tmp/../etc/passwd` is rejected before resolution-work.
  const normalized = path.posix.normalize(filePath);

  if (!isStrictlyUnderTmp(normalized)) {
    throw new Error('Absolute paths outside /tmp are not allowed');
  }

  const resolved = resolveAbsoluteUnderTmp(normalized);

  if (!isStrictlyUnderTmp(resolved)) {
    throw new Error('Absolute paths outside /tmp are not allowed');
  }

  return resolved;
}

/**
 * Validate only (does not rewrite the path). Prefer
 * `resolveSafeTailFilePath` when the resolved path will be passed to `tail`.
 */
export function assertSafeTailFilePath(filePath: string): void {
  resolveSafeTailFilePath(filePath);
}

function assertCommonPathRules(filePath: string): void {
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
}

function isStrictlyUnderTmp(absolutePath: string): boolean {
  // Require a path *inside* /tmp (not bare `/tmp` itself).
  return absolutePath.startsWith(`${TMP_ROOT}/`);
}

function isTmpRootOrBelow(absolutePath: string): boolean {
  return absolutePath === TMP_ROOT || isStrictlyUnderTmp(absolutePath);
}

/**
 * realpath the target when it exists. For not-yet-created logfiles, realpath
 * the deepest existing ancestor, re-join missing segments, and re-validate.
 */
function resolveAbsoluteUnderTmp(normalized: string): string {
  try {
    return fs.realpathSync.native(normalized);
  } catch (error) {
    if (!isEnoent(error)) {
      throw error;
    }
  }

  const missingSegments: string[] = [];
  let current = normalized;

  while (current !== '/' && !fs.existsSync(current)) {
    missingSegments.unshift(path.posix.basename(current));
    const parent = path.posix.dirname(current);

    if (parent === current) {
      break;
    }

    current = parent;
  }

  // Existing ancestor may be `/tmp` itself when the logfile has not been
  // created yet.
  if (!isTmpRootOrBelow(current) || !fs.existsSync(current)) {
    throw new Error('Absolute paths outside /tmp are not allowed');
  }

  const realBase = fs.realpathSync.native(current);

  if (!isTmpRootOrBelow(realBase)) {
    throw new Error('Absolute paths outside /tmp are not allowed');
  }

  if (missingSegments.length === 0) {
    return realBase;
  }

  // Join with posix so we never reintroduce platform separators under /tmp.
  return path.posix.join(realBase, ...missingSegments);
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}
