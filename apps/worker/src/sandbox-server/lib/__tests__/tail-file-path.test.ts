import fs from 'node:fs';
import path from 'node:path';

import {
  assertSafeTailFilePath,
  resolveSafeTailFilePath,
} from '../tail-file-path';

describe('resolveSafeTailFilePath', () => {
  it('allows workspace-relative paths unchanged', () => {
    expect(resolveSafeTailFilePath('logs/app.log')).toBe('logs/app.log');
    expect(resolveSafeTailFilePath('package.json')).toBe('package.json');
  });

  it('allows absolute paths under /tmp used by harness and docker logs', () => {
    expect(() => resolveSafeTailFilePath('/tmp/harness.log')).not.toThrow();
    expect(() =>
      resolveSafeTailFilePath('/tmp/roomote-docker-projects/roomote-api.log'),
    ).not.toThrow();
    expect(() => resolveSafeTailFilePath('/tmp/server.log')).not.toThrow();
  });

  it('rejects empty paths', () => {
    expect(() => resolveSafeTailFilePath('')).toThrow('Path cannot be empty');
    expect(() => resolveSafeTailFilePath('   ')).toThrow(
      'Path cannot be empty',
    );
  });

  it('rejects path traversal', () => {
    expect(() => resolveSafeTailFilePath('../etc/passwd')).toThrow(
      'Path traversal not allowed',
    );
    expect(() => resolveSafeTailFilePath('/tmp/../etc/passwd')).toThrow(
      'Path traversal not allowed',
    );
  });

  it('rejects absolute paths outside /tmp', () => {
    expect(() => resolveSafeTailFilePath('/etc/passwd')).toThrow(
      'Absolute paths outside /tmp are not allowed',
    );
    expect(() => resolveSafeTailFilePath('/var/log/syslog')).toThrow(
      'Absolute paths outside /tmp are not allowed',
    );
    expect(() => resolveSafeTailFilePath('/tmp')).toThrow(
      'Absolute paths outside /tmp are not allowed',
    );
  });

  it('rejects shell metacharacters', () => {
    expect(() => resolveSafeTailFilePath('file;rm -rf /')).toThrow(
      'Invalid characters in path',
    );
    expect(() => resolveSafeTailFilePath('$(whoami)')).toThrow(
      'Invalid characters in path',
    );
  });

  it('rejects control characters including DEL', () => {
    expect(() => resolveSafeTailFilePath('logs/\x00app.log')).toThrow(
      'Control characters not allowed in path',
    );
    expect(() => resolveSafeTailFilePath('logs/\x7fapp.log')).toThrow(
      'Control characters not allowed in path',
    );
  });

  it('rejects /tmp-relative symlinks that resolve outside /tmp', () => {
    // Create the target outside /tmp (workspace path), not under os.tmpdir().
    const dir = fs.mkdtempSync(path.join(process.cwd(), 'tail-path-escape-'));
    const outside = path.join(dir, 'secret.txt');
    fs.writeFileSync(outside, 'nope\n');
    const link = path.join('/tmp', `roomote-tail-escape-${process.pid}.link`);

    try {
      fs.symlinkSync(outside, link);

      expect(() => resolveSafeTailFilePath(link)).toThrow(
        'Absolute paths outside /tmp are not allowed',
      );
    } finally {
      fs.rmSync(link, { force: true });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns the real path for /tmp targets that exist', () => {
    const target = path.join('/tmp', `roomote-tail-real-${process.pid}.log`);
    fs.writeFileSync(target, 'ok\n');
    const link = path.join('/tmp', `roomote-tail-real-${process.pid}.link`);

    try {
      fs.symlinkSync(target, link);

      expect(resolveSafeTailFilePath(link)).toBe(
        fs.realpathSync.native(target),
      );
    } finally {
      fs.rmSync(link, { force: true });
      fs.rmSync(target, { force: true });
    }
  });

  it('allows not-yet-created absolute logfiles whose parent stays under /tmp', () => {
    const missing = path.join(
      '/tmp',
      `roomote-tail-missing-${process.pid}`,
      'nested',
      'app.log',
    );

    expect(resolveSafeTailFilePath(missing)).toBe(
      path.posix.normalize(missing),
    );
  });
});

describe('assertSafeTailFilePath', () => {
  it('delegates validation', () => {
    expect(() => assertSafeTailFilePath('logs/app.log')).not.toThrow();
    expect(() => assertSafeTailFilePath('/etc/passwd')).toThrow(
      'Absolute paths outside /tmp are not allowed',
    );
  });
});
