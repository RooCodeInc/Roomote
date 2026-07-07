import path from 'path';
import fs from 'fs';

import { execa } from 'execa';
import ora from 'ora';

import type { ScriptOptions } from '../types';
import {
  getDefaultLocalReleasesDir,
  getDefaultLocalWorkerReleaseArchivePath,
} from './local-releases';

const DEFAULT_LOCAL_WORKER_RELEASE_VERSION = 'local-dev';
const LOCAL_WORKER_RELEASE_BUILD_ENV = {
  SENTRY_AUTH_TOKEN: '',
  SENTRY_ORG: '',
  SENTRY_PROJECT: '',
};

interface LocalWorkerReleaseBuildOptions {
  rootDir?: string;
  version?: string;
  verbose?: boolean;
  skipIfArchiveExists?: boolean;
}

export class WorkerReleaseService {
  /**
   * Builds a local worker release archive for sandbox development.
   * Returns the absolute path to the archive.
   */
  public static async build(options: ScriptOptions): Promise<string> {
    return this.buildLocalDevRelease({
      rootDir: path.resolve(process.cwd(), '../..'),
      version: DEFAULT_LOCAL_WORKER_RELEASE_VERSION,
      verbose: options.verbose,
      skipIfArchiveExists: options.skipWorkerReleaseBuild,
    });
  }

  /**
   * Returns the default worker release archive path.
   */
  public static getDefaultArchivePath(rootDir?: string): string {
    return getDefaultLocalWorkerReleaseArchivePath(rootDir);
  }

  public static async buildLocalDevRelease(
    options: LocalWorkerReleaseBuildOptions,
  ): Promise<string> {
    const rootDir = options.rootDir ?? path.resolve(process.cwd(), '../..');
    const releasesDir = getDefaultLocalReleasesDir(rootDir);
    const archivePath = getDefaultLocalWorkerReleaseArchivePath(rootDir);
    const version = options.version ?? DEFAULT_LOCAL_WORKER_RELEASE_VERSION;

    if (options.skipIfArchiveExists && fs.existsSync(archivePath)) {
      console.info(
        `📦 Reusing existing worker release archive: ${archivePath}`,
      );
      return archivePath;
    }

    const buildArchive = ora('Building local worker release archive').start();

    try {
      await execa(
        './scripts/build-worker-release.sh',
        [version, '--output-dir', releasesDir],
        {
          cwd: rootDir,
          env: LOCAL_WORKER_RELEASE_BUILD_ENV,
          ...(options.verbose && { stdio: 'inherit' }),
        },
      );

      buildArchive.succeed(
        `Built local worker release archive in ${releasesDir}`,
      );

      return archivePath;
    } catch (error) {
      buildArchive.fail('Failed to build worker release archive');
      throw error;
    }
  }

  public static async ensureLocalDevReleaseCurrent(
    options: LocalWorkerReleaseBuildOptions,
  ): Promise<string> {
    const archivePath = getDefaultLocalWorkerReleaseArchivePath(
      options.rootDir,
    );

    if (fs.existsSync(archivePath)) {
      console.info(
        `📦 Reusing existing worker release archive: ${archivePath}`,
      );
      return archivePath;
    }

    return this.buildLocalDevRelease(options);
  }
}
