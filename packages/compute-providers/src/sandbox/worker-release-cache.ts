import type { SandboxLogFn } from '@roomote/types';

import {
  getWorkerReleaseSelectionCacheKey,
  normalizeWorkerReleaseSelection,
  type WorkerReleaseSelection,
} from './worker-release-selection';
import {
  downloadWorkerReleaseArchive,
  fetchWorkerReleaseMetadata,
} from './worker-release-github';

interface CachedRelease {
  tag: string;
  version: string;
  archive: Buffer;
}

/**
 * In-memory cache keyed by version string.
 * Typically holds 1-2 entries (~5MB each).
 */
const cache = new Map<string, CachedRelease>();

/**
 * In-flight fetch promises keyed by version string (or "__latest__" for
 * unversioned requests). Prevents redundant concurrent downloads when the
 * controller processes multiple jobs at startup.
 */
const inflight = new Map<string, Promise<CachedRelease>>();

/**
 * Internal fetch-and-cache logic, called once per cache miss. Concurrent
 * callers share the same promise via the `inflight` map in `getWorkerRelease`.
 */
async function fetchAndCache(
  selection?: Partial<WorkerReleaseSelection>,
  onLog?: SandboxLogFn,
): Promise<CachedRelease> {
  const metadata = await fetchWorkerReleaseMetadata(selection);
  const resolvedKey = getWorkerReleaseSelectionCacheKey({
    channel: metadata.channel,
    version: metadata.version,
  });

  // Check cache with the resolved version (handles the "latest" -> specific
  // version case, and races where another inflight request cached it first).
  const cached = cache.get(resolvedKey);

  if (cached) {
    logInfo(`Using cached worker release ${metadata.tag}`, onLog);
    return cached;
  }

  logInfo(`Downloading worker release ${metadata.tag} from GitHub...`, onLog);

  const archive = await downloadWorkerReleaseArchive(metadata.assetUrl);

  logInfo(
    `Downloaded worker release ${metadata.tag} (${(archive.length / 1024 / 1024).toFixed(1)}MB)`,
    onLog,
  );

  const entry: CachedRelease = {
    tag: metadata.tag,
    version: metadata.version,
    archive,
  };
  cache.set(resolvedKey, entry);

  return entry;
}

/**
 * Returns a worker release archive, using the in-memory cache when possible.
 * Concurrent requests for the same channel/version selection share a single
 * in-flight fetch to avoid redundant ~5MB downloads at startup.
 *
 * @returns The version string and the archive as a Buffer.
 */
export async function getWorkerRelease(
  selection?: Partial<WorkerReleaseSelection>,
  onLog?: SandboxLogFn,
): Promise<CachedRelease> {
  const resolvedSelection = normalizeWorkerReleaseSelection(selection);
  // Deduplicate concurrent in-flight requests. Callers requesting the same
  // version (or both requesting "latest") will await the same promise instead
  // of each starting their own download.
  const key = getWorkerReleaseSelectionCacheKey(resolvedSelection);
  const cached = resolvedSelection.version ? cache.get(key) : undefined;

  if (cached) {
    logInfo(`Using cached worker release ${cached.tag}`, onLog);
    return cached;
  }

  const pending = inflight.get(key);

  if (pending) {
    logInfo(`Joining in-flight request for worker release ${key}`, onLog);
    return pending;
  }

  const promise = fetchAndCache(resolvedSelection, onLog);
  inflight.set(key, promise);

  try {
    return await promise;
  } finally {
    inflight.delete(key);
  }
}

/**
 * Clears the in-memory release cache. Primarily useful for testing.
 */
export function clearWorkerReleaseCache(): void {
  cache.clear();
  inflight.clear();
}

function logInfo(message: string, onLog?: SandboxLogFn): void {
  if (onLog) {
    onLog('info', message);
    return;
  }

  console.log(message);
}
