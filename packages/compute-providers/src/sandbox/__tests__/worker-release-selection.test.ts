// pnpm --filter @roomote/compute-providers test src/sandbox/__tests__/worker-release-selection.test.ts

import {
  extractWorkerReleaseTagFromArchivePath,
  extractWorkerReleaseVersionFromArchivePath,
  parseWorkerReleaseTag,
  parseWorkerReleaseTagFromArchivePath,
} from '../worker-release-selection';

describe('parseWorkerReleaseTag', () => {
  it('parses stable tags', () => {
    expect(parseWorkerReleaseTag('worker-v1.2.3')).toEqual({
      channel: 'stable',
      tag: 'worker-v1.2.3',
      version: '1.2.3',
    });
  });

  it('parses preview tags as the preview channel, not stable', () => {
    expect(parseWorkerReleaseTag('worker-preview-v1.2.3-alpha.1')).toEqual({
      channel: 'preview',
      tag: 'worker-preview-v1.2.3-alpha.1',
      version: '1.2.3-alpha.1',
    });
  });

  it('returns null for tags without a version', () => {
    expect(parseWorkerReleaseTag('worker-v')).toBeNull();
    expect(parseWorkerReleaseTag('worker-preview-v')).toBeNull();
  });

  it('returns null for unrelated tags', () => {
    expect(parseWorkerReleaseTag('worker-current')).toBeNull();
    expect(parseWorkerReleaseTag('app-v1.2.3')).toBeNull();
  });
});

describe('parseWorkerReleaseTagFromArchivePath', () => {
  it('parses versioned stable archive paths', () => {
    expect(
      parseWorkerReleaseTagFromArchivePath(
        '/roomote/releases/worker-v1.2.3.tar.gz',
      ),
    ).toEqual({
      channel: 'stable',
      tag: 'worker-v1.2.3',
      version: '1.2.3',
    });
  });

  it('parses versioned preview archive paths', () => {
    expect(
      parseWorkerReleaseTagFromArchivePath(
        './releases/worker-preview-v1.2.3-alpha.1.tar.gz',
      ),
    ).toEqual({
      channel: 'preview',
      tag: 'worker-preview-v1.2.3-alpha.1',
      version: '1.2.3-alpha.1',
    });
  });

  it('returns null for version-less archive names', () => {
    expect(
      parseWorkerReleaseTagFromArchivePath(
        '/roomote/releases/worker-current.tar.gz',
      ),
    ).toBeNull();
  });

  it('returns null for non tar.gz paths', () => {
    expect(
      parseWorkerReleaseTagFromArchivePath(
        '/roomote/releases/worker-v1.2.3.zip',
      ),
    ).toBeNull();
  });
});

describe('extractWorkerReleaseTagFromArchivePath', () => {
  it('extracts the tag from versioned archive paths', () => {
    expect(
      extractWorkerReleaseTagFromArchivePath(
        '/roomote/releases/worker-v1.2.3.tar.gz',
      ),
    ).toBe('worker-v1.2.3');
  });

  it('throws for version-less archive names', () => {
    expect(() =>
      extractWorkerReleaseTagFromArchivePath(
        '/roomote/releases/worker-current.tar.gz',
      ),
    ).toThrow(
      /Invalid worker release archive filename: worker-current\.tar\.gz/,
    );
  });

  it('throws for non tar.gz paths', () => {
    expect(() =>
      extractWorkerReleaseTagFromArchivePath('/roomote/releases/worker-v1.2.3'),
    ).toThrow(/Invalid worker release archive filename/);
  });
});

describe('extractWorkerReleaseVersionFromArchivePath', () => {
  it('extracts stable versions', () => {
    expect(
      extractWorkerReleaseVersionFromArchivePath(
        '/roomote/releases/worker-v1.2.3.tar.gz',
      ),
    ).toBe('1.2.3');
  });

  it('extracts preview versions', () => {
    expect(
      extractWorkerReleaseVersionFromArchivePath(
        '/roomote/releases/worker-preview-v1.2.3-alpha.1.tar.gz',
      ),
    ).toBe('1.2.3-alpha.1');
  });
});
