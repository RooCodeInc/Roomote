// pnpm --filter @roomote/compute-providers test src/sandbox/__tests__/utils.test.ts

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';

import { loadLocalWorkerReleaseWithVersion } from '../utils';

function makeTarEntry(name: string, content: string): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf-8');
  header.write('0000644\0', 100, 8, 'utf-8');
  header.write('0000000\0', 108, 8, 'utf-8');
  header.write('0000000\0', 116, 8, 'utf-8');

  const body = Buffer.from(content, 'utf-8');
  header.write(
    `${body.length.toString(8).padStart(11, '0')}\0`,
    124,
    12,
    'utf-8',
  );
  header.write('00000000000\0', 136, 12, 'utf-8');
  header.write('        ', 148, 8, 'utf-8');
  header.write('0', 156, 1, 'utf-8');

  let checksum = 0;
  for (const byte of header) {
    checksum += byte;
  }
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'utf-8');

  const paddedBody = Buffer.alloc(Math.ceil(body.length / 512) * 512);
  body.copy(paddedBody);

  return Buffer.concat([header, paddedBody]);
}

function makeWorkerReleaseArchive(entries: Record<string, string>): Buffer {
  const blocks = Object.entries(entries).map(([name, content]) =>
    makeTarEntry(name, content),
  );
  blocks.push(Buffer.alloc(1024));

  return zlib.gzipSync(Buffer.concat(blocks));
}

describe('loadLocalWorkerReleaseWithVersion', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-release-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function writeArchive(filename: string, archive: Buffer): string {
    const archivePath = path.join(tempDir, filename);
    fs.writeFileSync(archivePath, archive);
    return archivePath;
  }

  it('resolves the version from versioned filenames without reading the archive', () => {
    const archive = makeWorkerReleaseArchive({
      'worker-v9.9.9/VERSION': '9.9.9\n',
    });
    const archivePath = writeArchive('worker-v1.2.3.tar.gz', archive);

    const release = loadLocalWorkerReleaseWithVersion(archivePath);

    expect(release.version).toBe('1.2.3');
    expect(release.archive.equals(archive)).toBe(true);
  });

  it('resolves preview versions from versioned filenames', () => {
    const archive = makeWorkerReleaseArchive({});
    const archivePath = writeArchive(
      'worker-preview-v1.2.3-alpha.1.tar.gz',
      archive,
    );

    expect(loadLocalWorkerReleaseWithVersion(archivePath).version).toBe(
      '1.2.3-alpha.1',
    );
  });

  it('falls back to the packaged VERSION file for version-less filenames', () => {
    const archive = makeWorkerReleaseArchive({
      'worker-v4.5.6/dist/worker.js': 'console.log("worker");\n',
      'worker-v4.5.6/VERSION': '4.5.6\n',
      'worker-v4.5.6/COMMIT': 'abc123\n',
    });
    const archivePath = writeArchive('worker-current.tar.gz', archive);

    const release = loadLocalWorkerReleaseWithVersion(archivePath);

    expect(release.version).toBe('4.5.6');
    expect(release.archive.equals(archive)).toBe(true);
  });

  it('throws when a version-less archive has no VERSION file', () => {
    const archive = makeWorkerReleaseArchive({
      'worker-v4.5.6/dist/worker.js': 'console.log("worker");\n',
    });
    const archivePath = writeArchive('worker-current.tar.gz', archive);

    expect(() => loadLocalWorkerReleaseWithVersion(archivePath)).toThrow(
      /Unable to determine worker release version/,
    );
  });

  it('throws when the archive does not exist', () => {
    expect(() =>
      loadLocalWorkerReleaseWithVersion(path.join(tempDir, 'missing.tar.gz')),
    ).toThrow(/Local worker release archive not found/);
  });
});
