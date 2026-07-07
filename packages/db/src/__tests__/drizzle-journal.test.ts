import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const journalEntrySchema = z.object({
  idx: z.number().int().nonnegative(),
  version: z.string().min(1),
  when: z.number().int().nonnegative(),
  tag: z.string().regex(/^\d{4}_[a-z0-9_]+$/),
  breakpoints: z.boolean(),
});

const journalSchema = z.object({
  version: z.string().min(1),
  dialect: z.literal('postgresql'),
  entries: z.array(journalEntrySchema).min(1),
});

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(currentDir, '../..');
const journalPath = path.join(packageRoot, 'drizzle/meta/_journal.json');
const drizzleDirectory = path.join(packageRoot, 'drizzle');

function readJournal() {
  const content = readFileSync(journalPath, 'utf8');
  return journalSchema.parse(JSON.parse(content) as unknown);
}

function listMigrationFileNames() {
  return readdirSync(drizzleDirectory)
    .filter((fileName) => fileName.endsWith('.sql'))
    .sort();
}

function getMigrationNumber(fileName: string) {
  const match = /^(\d{4})_[a-z0-9_]+\.sql$/.exec(fileName);
  expect(match, `Invalid migration filename: ${fileName}`).not.toBeNull();
  return match?.[1];
}

describe('drizzle journal metadata', () => {
  it('is internally consistent and matches migration files', () => {
    const journal = readJournal();
    const migrationFileNames = listMigrationFileNames();
    const migrationFilesByNumber = new Map<string, string[]>();

    for (const fileName of migrationFileNames) {
      const migrationNumber = getMigrationNumber(fileName);

      if (!migrationNumber) {
        continue;
      }

      const fileNames = migrationFilesByNumber.get(migrationNumber) ?? [];
      fileNames.push(fileName);
      migrationFilesByNumber.set(migrationNumber, fileNames);
    }

    const collidingMigrationNumbers = Array.from(
      migrationFilesByNumber.values(),
    ).filter((fileNames) => fileNames.length > 1);
    expect(collidingMigrationNumbers).toEqual([]);

    const journalTags = journal.entries.map((entry) => entry.tag).sort();
    const fileTags = migrationFileNames
      .map((fileName) => fileName.slice(0, -4))
      .sort();

    expect(journalTags).toEqual(fileTags);

    const seenIdx = new Set<number>();
    let previousIdx: number | undefined;
    let previousWhen: number | undefined;

    for (const entry of journal.entries) {
      expect(seenIdx.has(entry.idx)).toBe(false);
      seenIdx.add(entry.idx);

      if (previousIdx !== undefined) {
        expect(entry.idx).toBeGreaterThan(previousIdx);
      }

      if (previousWhen !== undefined) {
        expect(entry.when).toBeGreaterThan(previousWhen);
      }

      previousIdx = entry.idx;
      previousWhen = entry.when;
    }
  });
});
