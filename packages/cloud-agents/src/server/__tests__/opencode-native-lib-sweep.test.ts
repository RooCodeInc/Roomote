import {
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sweepOpenCodeExtractedNativeLibraries } from '../opencode-native-lib-sweep';

describe('sweepOpenCodeExtractedNativeLibraries', () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'native-lib-sweep-'));
  });
  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  const write = (name: string, ageMs: number, now: number) => {
    const path = join(directory, name);
    writeFileSync(path, 'x');
    const seconds = (now - ageMs) / 1000;
    utimesSync(path, seconds, seconds);
  };

  it('removes only aged Bun-extracted libraries', () => {
    const now = Date.now();
    write('.bcffe55fffe7fbef-00000000.so', 120_000, now);
    write('.bcffe57efdfdb6ac-00000000.so', 5_000, now);
    write('.bcffe57efdfdb6ad-00000001.so', 120_000, now);
    write('keep.so', 120_000, now);
    write('.cache', 120_000, now);

    expect(sweepOpenCodeExtractedNativeLibraries({ directory, now })).toBe(1);
    expect(readdirSync(directory).sort()).toEqual([
      '.bcffe57efdfdb6ac-00000000.so',
      '.bcffe57efdfdb6ad-00000001.so',
      '.cache',
      'keep.so',
    ]);
  });

  it('tolerates a missing directory', () => {
    expect(
      sweepOpenCodeExtractedNativeLibraries({
        directory: join(directory, 'missing'),
      }),
    ).toBe(0);
  });
});
