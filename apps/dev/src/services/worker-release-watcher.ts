import fs from 'node:fs';
import path from 'node:path';

import { getDefaultLocalWorkerReleaseArchivePath } from './local-releases';
import { WorkerReleaseService } from './worker-release';

/**
 * Directories to watch for worker-relevant file changes, relative to the
 * monorepo root.  These cover the worker app itself plus every internal
 * workspace dependency listed in its package.json (you can regenerate the
 * list with `pnpm --filter @roomote/worker internal-deps`).
 *
 * The Docker config directory is included because its contents are bundled
 * into the worker release archive. Packaged skills are watched separately from the cloud-
 * agents workflow skills source directory.
 */
const WATCH_DIRS = [
  'apps/worker/assets',
  'apps/worker/src',
  'apps/worker/scripts',
  'packages/auth/src',
  'packages/cloud-agents/src',
  'packages/linear/src',
  'packages/sdk/src',
  'packages/slack/src',
  'packages/types/src',
  '.docker/config',
];

/** Debounce window -- wait this long after the last change before rebuilding. */
const DEBOUNCE_MS = 1_500;

/**
 * Extract the version string from a worker release archive path.
 *
 * Expects filenames matching `worker-v<VERSION>.tar.gz`.  Returns the
 * default `local-dev` when the pattern doesn't match or no path is given.
 */
export function versionFromWorkerReleasePath(
  workerReleasePath?: string,
): string {
  if (!workerReleasePath) {
    return 'local-dev';
  }

  const basename = path.basename(workerReleasePath);
  const match = /^worker-v(.+)\.tar\.gz$/.exec(basename);
  return match?.[1] ?? 'local-dev';
}

/**
 * Watches worker source files and automatically rebuilds the release archive when
 * changes are detected.  Designed to run as a long-lived PM2 service
 * alongside the rest of the dev environment.
 *
 * The watcher always writes to the shared default local worker release
 * archive path in `./releases`. This keeps the watcher, the controller, and
 * the dev build scripts in sync without any manual coordination.
 *
 * Uses Node's built-in `fs.watch` with `recursive: true` (requires
 * Node >= 19, Linux >= 5.9).
 */
export class WorkerReleaseWatcherService {
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private isRebuilding = false;
  private pendingRebuild = false;
  private abortControllers: AbortController[] = [];
  private rootDir: string;
  /** Resolved archive path, e.g. `releases/worker-vlocal-dev.tar.gz`. */
  private workerReleasePath: string;
  /** Version string passed to `build-worker-release.sh`, e.g. `local-dev`. */
  private version: string;

  public constructor(rootDir?: string) {
    this.rootDir = rootDir ?? path.resolve(process.cwd());
    this.workerReleasePath = getDefaultLocalWorkerReleaseArchivePath(
      this.rootDir,
    );
    this.version = versionFromWorkerReleasePath(this.workerReleasePath);
  }

  /**
   * Start watching for file changes and rebuilding the worker release archive.
   *
   * If the archive does not already exist on disk, an initial build is
   * triggered immediately so that a separate "build worker release archive" setup
   * step is not required.
   */
  public start(): void {
    console.log('[worker-release-watcher] Starting worker release watcher');
    console.log(
      `[worker-release-watcher] Archive: ${path.relative(this.rootDir, this.workerReleasePath)} (version: ${this.version})`,
    );
    console.log(
      `[worker-release-watcher] Watching ${WATCH_DIRS.length} directories for changes`,
    );

    // Build immediately if the archive doesn't exist yet.
    if (!fs.existsSync(this.workerReleasePath)) {
      console.log(
        '[worker-release-watcher] Archive not found on disk -- running initial build',
      );
      void this.rebuild();
    }

    for (const relDir of WATCH_DIRS) {
      const absDir = path.resolve(this.rootDir, relDir);

      if (!fs.existsSync(absDir)) {
        console.warn(
          `[worker-release-watcher] Skipping missing directory: ${relDir}`,
        );
        continue;
      }

      const ac = new AbortController();
      this.abortControllers.push(ac);

      try {
        const watcher = fs.watch(
          absDir,
          { recursive: true, signal: ac.signal },
          (_eventType, filename) => {
            if (!filename) {
              return;
            }

            // Ignore common non-source files.
            if (this.shouldIgnore(filename)) {
              return;
            }

            console.log(
              `[worker-release-watcher] Change detected: ${relDir}/${filename}`,
            );
            this.scheduleRebuild();
          },
        );

        watcher.on('error', (err) => {
          // AbortError is expected during shutdown.
          if ((err as NodeJS.ErrnoException).name === 'AbortError') {
            return;
          }
          console.error(
            `[worker-release-watcher] Watch error on ${relDir}: ${err.message}`,
          );
        });

        console.log(`[worker-release-watcher] Watching: ${relDir}`);
      } catch (err) {
        console.error(
          `[worker-release-watcher] Failed to watch ${relDir}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    console.log('[worker-release-watcher] Ready -- waiting for file changes');
  }

  /**
   * Stop all file watchers and cancel any pending rebuild.
   */
  public stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    for (const ac of this.abortControllers) {
      ac.abort();
    }

    this.abortControllers = [];
    console.log('[worker-release-watcher] Stopped');
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private shouldIgnore(filename: string): boolean {
    // Ignore dotfiles, build outputs, test/spec files, and maps.
    return (
      /(?:^\.|\bnode_modules\b|\bdist\b|\.test\.|\.spec\.|\.map$)/.test(
        filename,
      ) ||
      /(?:^|[\\/])builder[\\/]build(?:[\\/]|$)/.test(filename) ||
      /(?:^|[\\/])builder[\\/]www(?:[\\/]|$)/.test(filename) ||
      /(?:^|[\\/])upstream-sync(?:[\\/]|$)/.test(filename)
    );
  }

  private scheduleRebuild(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.rebuild();
    }, DEBOUNCE_MS);
  }

  private async rebuild(): Promise<void> {
    // If a rebuild is already in progress, flag that another is needed.
    if (this.isRebuilding) {
      this.pendingRebuild = true;
      return;
    }

    this.isRebuilding = true;

    try {
      console.log(
        '[worker-release-watcher] Rebuilding worker release archive...',
      );
      const start = Date.now();
      await WorkerReleaseService.buildLocalDevRelease({
        rootDir: this.rootDir,
        version: this.version,
      });

      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      console.log(
        `[worker-release-watcher] Worker release archive rebuilt in ${elapsed}s: ${path.relative(
          this.rootDir,
          this.workerReleasePath,
        )}`,
      );
    } catch (err) {
      console.error(
        `[worker-release-watcher] Rebuild failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.isRebuilding = false;

      // If another change came in during the build, rebuild again.
      if (this.pendingRebuild) {
        this.pendingRebuild = false;
        void this.rebuild();
      }
    }
  }
}
