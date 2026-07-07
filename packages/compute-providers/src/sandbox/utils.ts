import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import { resolveFromWorkspaceRoot } from '../repo-paths';

import {
  parseWorkerReleaseTagFromArchivePath,
  normalizeWorkerReleaseSelection,
  type WorkerReleaseSelection,
} from './worker-release-selection';
import { fetchWorkerReleaseMetadata } from './worker-release-github';

const SANDBOX_SOURCE_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * Loads a worker release archive from the local filesystem.
 * Used for testing release-style deployments without publishing.
 *
 * @param archivePath - Path to the local worker release archive
 * @returns The archive content as a Buffer
 */
export function loadLocalWorkerRelease(archivePath: string): Buffer {
  const absolutePath = path.isAbsolute(archivePath)
    ? archivePath
    : resolveFromWorkspaceRoot(archivePath, SANDBOX_SOURCE_DIR);

  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Local worker release archive not found: ${absolutePath}`);
  }

  return fs.readFileSync(absolutePath);
}

export interface LocalWorkerRelease {
  archive: Buffer;
  version: string;
}

/**
 * Loads a local worker release archive and resolves its version.
 *
 * Versioned filenames (worker-v<version>.tar.gz, worker-preview-v<version>.tar.gz)
 * resolve from the filename alone. Version-less names such as the
 * worker-current.tar.gz alias baked into the app image fall back to the
 * VERSION file that build-worker-release.sh packages inside the archive.
 */
export function loadLocalWorkerReleaseWithVersion(
  archivePath: string,
): LocalWorkerRelease {
  const archive = loadLocalWorkerRelease(archivePath);
  const parsed = parseWorkerReleaseTagFromArchivePath(archivePath);

  if (parsed) {
    return { archive, version: parsed.version };
  }

  const version = getWorkerVersionFromWorkerReleaseArchive(archive);

  if (!version) {
    throw new Error(
      `Unable to determine worker release version for ${archivePath}: the filename does not match worker-v<version>.tar.gz or worker-preview-v<version>.tar.gz and the archive does not contain a VERSION file`,
    );
  }

  return { archive, version };
}

function parseTarOctalField(
  header: Buffer,
  start: number,
  length: number,
): number {
  const rawValue = header
    .toString('utf-8', start, start + length)
    .replace(/\0.*$/, '')
    .trim();

  if (!rawValue) {
    return 0;
  }

  return Number.parseInt(rawValue, 8);
}

function isZeroTarBlock(block: Buffer): boolean {
  for (const byte of block) {
    if (byte !== 0) {
      return false;
    }
  }

  return true;
}

function readTarEntryPath(header: Buffer): string {
  const name = header.toString('utf-8', 0, 100).replace(/\0.*$/, '');
  const prefix = header.toString('utf-8', 345, 500).replace(/\0.*$/, '');

  return prefix ? `${prefix}/${name}` : name;
}

function readTextFileFromWorkerReleaseArchive(
  archiveBuffer: Buffer,
  matcher: (entryPath: string) => boolean,
): string | null {
  const archive = zlib.gunzipSync(archiveBuffer);
  let offset = 0;

  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);

    if (isZeroTarBlock(header)) {
      break;
    }

    const entryPath = readTarEntryPath(header);
    const size = parseTarOctalField(header, 124, 12);

    if (Number.isNaN(size) || size < 0) {
      throw new Error(`Invalid tar entry size in worker release: ${entryPath}`);
    }

    if (matcher(entryPath)) {
      const start = offset + 512;
      const end = start + size;
      const value = archive.subarray(start, end).toString('utf-8').trim();

      return value || null;
    }

    offset += 512 + Math.ceil(size / 512) * 512;
  }

  return null;
}

export function getWorkerVersionFromWorkerReleaseArchive(
  archiveBuffer: Buffer,
): string | null {
  return readTextFileFromWorkerReleaseArchive(archiveBuffer, (entryPath) =>
    entryPath.endsWith('/VERSION'),
  );
}

export function getWorkerCommitFromWorkerReleaseArchive(
  archiveBuffer: Buffer,
): string | null {
  return readTextFileFromWorkerReleaseArchive(archiveBuffer, (entryPath) =>
    entryPath.endsWith('/COMMIT'),
  );
}

/**
 * Resolves the desired worker release version.
 *
 * When a version is pinned, returns it directly. Otherwise, fetches the latest
 * runnable release version for the active channel from GitHub.
 */
export async function getLatestWorkerVersion(
  selection?: Partial<WorkerReleaseSelection>,
): Promise<string> {
  const resolvedSelection = normalizeWorkerReleaseSelection(selection);

  if (resolvedSelection.version) {
    return resolvedSelection.version;
  }

  const metadata = await fetchWorkerReleaseMetadata(resolvedSelection);
  return metadata.version;
}

export interface WorkerUpdateCheck {
  needsUpdate: boolean;
  latestVersion: string | null;
}
