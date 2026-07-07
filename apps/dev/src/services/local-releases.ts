import path from 'node:path';

const DEFAULT_LOCAL_RELEASES_DIR_NAME = 'releases';

const DEFAULT_LOCAL_WORKER_RELEASE_ARCHIVE_NAME = 'worker-vlocal-dev.tar.gz';

export function getDefaultLocalReleasesDir(rootDir?: string): string {
  const resolvedRootDir = rootDir ?? path.resolve(process.cwd(), '../..');
  return path.join(resolvedRootDir, DEFAULT_LOCAL_RELEASES_DIR_NAME);
}

export function getDefaultLocalWorkerReleaseArchivePath(
  rootDir?: string,
): string {
  return path.join(
    getDefaultLocalReleasesDir(rootDir),
    DEFAULT_LOCAL_WORKER_RELEASE_ARCHIVE_NAME,
  );
}
