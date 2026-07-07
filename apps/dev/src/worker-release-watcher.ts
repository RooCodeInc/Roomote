/**
 * Standalone entry point for the worker release watcher PM2 service.
 *
 * Watches worker source files and automatically rebuilds the release archive when
 * changes are detected. Run via PM2 as part of `pnpm dev`.
 */
import path from 'node:path';

import { WorkerReleaseWatcherService } from './services/worker-release-watcher';

const rootDir = path.resolve(process.cwd(), '../..');

const watcher = new WorkerReleaseWatcherService(rootDir);
watcher.start();

// Keep the process alive.
process.on('SIGINT', () => {
  watcher.stop();
  process.exit(0);
});

process.on('SIGTERM', () => {
  watcher.stop();
  process.exit(0);
});
