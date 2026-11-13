import { readdirSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The OpenCode binary is a Bun single-file executable. Each process start
 * extracts its embedded native addon (`@parcel/watcher`, ~5.5 MB) into the
 * temp directory as `.<16 hex>-00000000.so` and never removes it. Control-plane
 * services start an OpenCode server per task-helper lease, so these files
 * accumulate until Railway evicts the container for exceeding ephemeral disk.
 *
 * Deleting an extracted library is safe even while a live process has it
 * mapped: Linux keeps the inode until the last mapping goes away, and Bun
 * never reopens the path. The age floor only avoids racing a process that is
 * still writing the file.
 */
const EXTRACTED_NATIVE_LIB_PATTERN =
  /^\.[0-9a-f]{16}-0{8}\.(?:so|dylib|node)$/u;
const DEFAULT_MIN_AGE_MS = 60_000;

export function sweepOpenCodeExtractedNativeLibraries(
  options: { directory?: string; now?: number; minAgeMs?: number } = {},
): number {
  const directory = options.directory ?? tmpdir();
  const now = options.now ?? Date.now();
  const minAgeMs = options.minAgeMs ?? DEFAULT_MIN_AGE_MS;
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!EXTRACTED_NATIVE_LIB_PATTERN.test(entry)) continue;
    const path = join(directory, entry);
    try {
      const stats = statSync(path);
      if (!stats.isFile() || now - stats.mtimeMs < minAgeMs) continue;
      unlinkSync(path);
      removed += 1;
    } catch {
      // Another process removed it, or it is not ours to delete.
    }
  }
  return removed;
}
