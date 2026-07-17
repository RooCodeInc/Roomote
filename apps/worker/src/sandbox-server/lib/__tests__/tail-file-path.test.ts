import { assertSafeTailFilePath } from '../tail-file-path';

describe('assertSafeTailFilePath', () => {
  it('allows workspace-relative paths', () => {
    expect(() => assertSafeTailFilePath('logs/app.log')).not.toThrow();
    expect(() => assertSafeTailFilePath('package.json')).not.toThrow();
  });

  it('allows absolute paths under /tmp used by harness and docker logs', () => {
    expect(() => assertSafeTailFilePath('/tmp/harness.log')).not.toThrow();
    expect(() =>
      assertSafeTailFilePath('/tmp/roomote-docker-projects/roomote-api.log'),
    ).not.toThrow();
    expect(() => assertSafeTailFilePath('/tmp/server.log')).not.toThrow();
  });

  it('rejects empty paths', () => {
    expect(() => assertSafeTailFilePath('')).toThrow('Path cannot be empty');
    expect(() => assertSafeTailFilePath('   ')).toThrow('Path cannot be empty');
  });

  it('rejects path traversal', () => {
    expect(() => assertSafeTailFilePath('../etc/passwd')).toThrow(
      'Path traversal not allowed',
    );
    expect(() => assertSafeTailFilePath('/tmp/../etc/passwd')).toThrow(
      'Path traversal not allowed',
    );
  });

  it('rejects absolute paths outside /tmp', () => {
    expect(() => assertSafeTailFilePath('/etc/passwd')).toThrow(
      'Absolute paths outside /tmp are not allowed',
    );
    expect(() => assertSafeTailFilePath('/var/log/syslog')).toThrow(
      'Absolute paths outside /tmp are not allowed',
    );
    expect(() => assertSafeTailFilePath('/tmp')).toThrow(
      'Absolute paths outside /tmp are not allowed',
    );
  });

  it('rejects shell metacharacters', () => {
    expect(() => assertSafeTailFilePath('file;rm -rf /')).toThrow(
      'Invalid characters in path',
    );
    expect(() => assertSafeTailFilePath('$(whoami)')).toThrow(
      'Invalid characters in path',
    );
  });

  it('rejects control characters including DEL', () => {
    expect(() => assertSafeTailFilePath('logs/\x00app.log')).toThrow(
      'Control characters not allowed in path',
    );
    expect(() => assertSafeTailFilePath('logs/\x7fapp.log')).toThrow(
      'Control characters not allowed in path',
    );
  });
});
