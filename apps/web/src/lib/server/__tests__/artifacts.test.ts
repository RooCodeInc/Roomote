import {
  db,
  sessionFactory,
  taskArtifacts,
  taskFactory,
} from '@roomote/db/server';

import {
  getArtifactByPath,
  getArtifactBySessionPath,
  validateArtifactPath,
  validateArtifactSize,
} from '../artifacts';

describe.each(['task', 'session'] as const)(
  '%s artifact path lookup',
  (scope) => {
    let ownerId: string;
    const path = 'reports/result.pdf';
    const auth = { userId: null, isAdmin: false };

    function lookup(artifactPath = path, version?: number) {
      return scope === 'task'
        ? getArtifactByPath({
            taskId: ownerId,
            path: artifactPath,
            version,
            auth,
          })
        : getArtifactBySessionPath({
            sessionId: ownerId,
            path: artifactPath,
            version,
            auth,
          });
    }

    beforeEach(async () => {
      ownerId =
        scope === 'task'
          ? (await taskFactory.create()).id
          : (await sessionFactory.create()).id;
      const owner =
        scope === 'task' ? { taskId: ownerId } : { sessionId: ownerId };
      await db.insert(taskArtifacts).values(
        [1, 2, 3].map((version) => ({
          ...owner,
          path,
          version,
          uploaded: version < 3,
          contentType: 'application/pdf',
          size: 100,
        })),
      );
    });

    it('returns the latest uploaded version when a newer upload is incomplete', async () => {
      await expect(lookup()).resolves.toMatchObject({
        path,
        version: 2,
        uploaded: true,
      });
    });

    it('retains exact version lookups, including incomplete upload metadata', async () => {
      for (const version of [1, 2, 3]) {
        await expect(lookup(path, version)).resolves.toMatchObject({
          path,
          version,
          uploaded: version < 3,
        });
      }
      await expect(lookup(path, 4)).resolves.toBeNull();
    });

    it('returns no latest artifact when every version is incomplete', async () => {
      const incompletePath = 'reports/incomplete.pdf';
      const owner =
        scope === 'task' ? { taskId: ownerId } : { sessionId: ownerId };
      await db.insert(taskArtifacts).values(
        [1, 2].map((version) => ({
          ...owner,
          path: incompletePath,
          version,
          uploaded: false,
          contentType: 'application/pdf',
          size: 100,
        })),
      );

      await expect(lookup(incompletePath)).resolves.toBeNull();
    });
  },
);

describe('validateArtifactPath', () => {
  it('should accept valid paths', () => {
    const validPaths = [
      'document.pdf',
      'diagram.png',
      'my-file.txt',
      'data_export.csv',
      'report-2024.docx',
      'very-long-filename-with-many-words-but-still-valid.txt',
      'plans/architecture.md',
      'docs/api/endpoints.json',
      'images/diagrams/flow-chart.png',
      // Filenames with consecutive dots are valid (not traversal attempts)
      'file..name.txt',
      'report..final.pdf',
      'data...backup.csv',
    ];

    validPaths.forEach((path) => {
      const result = validateArtifactPath(path);
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });
  });

  it('should reject empty path', () => {
    const result = validateArtifactPath('');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Path cannot be empty');
  });

  it('should reject whitespace-only path', () => {
    const result = validateArtifactPath('   ');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Path cannot be empty');
  });

  it('should reject paths with path traversal attempts using ..', () => {
    const maliciousPaths = [
      '../etc/passwd',
      'folder/../secret.txt',
      '../../config.json',
      '..',
      'folder/..',
      '..\\etc\\passwd',
      'folder\\..\\secret.txt',
    ];

    maliciousPaths.forEach((path) => {
      const result = validateArtifactPath(path);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Invalid path: path traversal detected');
    });
  });

  it('should reject absolute paths', () => {
    const maliciousPaths = [
      '/etc/passwd',
      '/root/secret.txt',
      '/file.txt',
      'C:\\Users\\roomote\\secret.txt',
    ];

    maliciousPaths.forEach((path) => {
      const result = validateArtifactPath(path);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Invalid path: absolute paths are not allowed');
    });
  });

  it('should reject paths with null byte injection', () => {
    const maliciousPaths = ['file\0.txt', 'document.pdf\0.exe', '\0malicious'];

    maliciousPaths.forEach((path) => {
      const result = validateArtifactPath(path);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Invalid path: null byte detected');
    });
  });

  it('should reject paths exceeding max length (255 chars)', () => {
    const longPath = 'a'.repeat(256);
    const result = validateArtifactPath(longPath);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Path too long (max 255 chars)');
  });

  it('should accept paths at exactly max length (255 chars)', () => {
    const maxLengthPath = 'a'.repeat(255);
    const result = validateArtifactPath(maxLengthPath);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });
});

describe('validateArtifactSize', () => {
  it('should accept valid file sizes', () => {
    const validSizes = [
      1, // 1 byte
      1024, // 1 KB
      1024 * 1024, // 1 MB
      50 * 1024 * 1024, // 50 MB
      100 * 1024 * 1024, // 100 MB (max size)
    ];

    validSizes.forEach((size) => {
      const result = validateArtifactSize(size);
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });
  });

  it('should reject zero size', () => {
    const result = validateArtifactSize(0);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('File size must be positive');
  });

  it('should reject negative sizes', () => {
    const negativeSizes = [-1, -100, -1024];

    negativeSizes.forEach((size) => {
      const result = validateArtifactSize(size);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('File size must be positive');
    });
  });

  it('should reject sizes exceeding max size (100MB)', () => {
    const maxSize = 100 * 1024 * 1024;
    const oversizedFiles = [
      maxSize + 1,
      maxSize + 1024,
      200 * 1024 * 1024, // 200 MB
      1024 * 1024 * 1024, // 1 GB
    ];

    oversizedFiles.forEach((size) => {
      const result = validateArtifactSize(size);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('File too large (max 100MB)');
    });
  });

  it('should accept size at exactly max size (100MB)', () => {
    const maxSize = 100 * 1024 * 1024;
    const result = validateArtifactSize(maxSize);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });
});
