import { mockClient } from 'aws-sdk-client-mock';
import {
  S3Client,
  DeleteObjectCommand,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';

import {
  generateUploadUrl,
  generateDownloadUrl,
  deleteArtifact,
  deleteArtifactsBatch,
  getArtifactKey,
} from '../s3-client';

// Mock the S3 client
const s3Mock = mockClient(S3Client);

beforeEach(() => {
  s3Mock.reset();
});

describe('getArtifactKey', () => {
  it('should generate correct S3 key format with version', () => {
    const key = getArtifactKey('task-123', 'artifact-456', 'document.pdf', 1);
    expect(key).toBe('tasks/task-123/artifacts/artifact-456/v1/document.pdf');
  });

  it('should generate legacy S3 key format for version 0', () => {
    const key = getArtifactKey('task-123', 'artifact-456', 'document.pdf', 0);
    expect(key).toBe('tasks/task-123/artifacts/artifact-456/document.pdf');
  });

  it('should handle special characters in path with version', () => {
    const key = getArtifactKey(
      'task-abc',
      'artifact-def',
      'my file (version 2).txt',
      2,
    );
    expect(key).toBe(
      'tasks/task-abc/artifacts/artifact-def/v2/my file (version 2).txt',
    );
  });

  it('should handle special characters in path with legacy version 0', () => {
    const key = getArtifactKey(
      'task-abc',
      'artifact-def',
      'my file (legacy).txt',
      0,
    );
    expect(key).toBe(
      'tasks/task-abc/artifacts/artifact-def/my file (legacy).txt',
    );
  });

  it('should handle nested paths with version', () => {
    const key = getArtifactKey(
      'task-123',
      'artifact-456',
      'plans/architecture.md',
      3,
    );
    expect(key).toBe(
      'tasks/task-123/artifacts/artifact-456/v3/plans/architecture.md',
    );
  });

  it('should handle nested paths with legacy version 0', () => {
    const key = getArtifactKey(
      'task-123',
      'artifact-456',
      'plans/architecture.md',
      0,
    );
    expect(key).toBe(
      'tasks/task-123/artifacts/artifact-456/plans/architecture.md',
    );
  });
});

describe('generateUploadUrl', () => {
  it('should generate valid presigned upload URL', async () => {
    const url = await generateUploadUrl(
      'task-123',
      'artifact-456',
      'document.pdf',
      1,
      'application/pdf',
      1024,
    );

    // Presigned URLs should be strings
    expect(typeof url).toBe('string');
    expect(url.length).toBeGreaterThan(0);

    // Should contain the key path with version
    expect(url).toContain(
      'tasks/task-123/artifacts/artifact-456/v1/document.pdf',
    );
  });

  it('should generate different URLs for different files', async () => {
    const url1 = await generateUploadUrl(
      'task-123',
      'artifact-456',
      'image.png',
      1,
      'image/png',
      2048,
    );

    const url2 = await generateUploadUrl(
      'task-123',
      'artifact-789',
      'document.pdf',
      1,
      'application/pdf',
      4096,
    );

    // URLs should be different for different artifacts
    expect(url1).not.toBe(url2);
    expect(url1).toContain(
      'tasks/task-123/artifacts/artifact-456/v1/image.png',
    );
    expect(url2).toContain(
      'tasks/task-123/artifacts/artifact-789/v1/document.pdf',
    );
  });
});

describe('generateDownloadUrl', () => {
  it('should generate valid presigned download URL', async () => {
    const url = await generateDownloadUrl(
      'task-123',
      'artifact-456',
      'document.pdf',
      1,
    );

    // Presigned URLs should be strings
    expect(typeof url).toBe('string');
    expect(url.length).toBeGreaterThan(0);

    // Should contain the key path with version
    expect(url).toContain(
      'tasks/task-123/artifacts/artifact-456/v1/document.pdf',
    );
  });

  it('should generate different URLs for different downloads', async () => {
    const url1 = await generateDownloadUrl(
      'task-123',
      'artifact-456',
      'report.xlsx',
      1,
    );

    const url2 = await generateDownloadUrl(
      'task-456',
      'artifact-789',
      'document.pdf',
      1,
    );

    // URLs should be different for different artifacts
    expect(url1).not.toBe(url2);
    expect(url1).toContain(
      'tasks/task-123/artifacts/artifact-456/v1/report.xlsx',
    );
    expect(url2).toContain(
      'tasks/task-456/artifacts/artifact-789/v1/document.pdf',
    );
  });
});

describe('deleteArtifact', () => {
  it('should delete single artifact from S3', async () => {
    s3Mock.on(DeleteObjectCommand).resolves({});

    await deleteArtifact('task-123', 'artifact-456', 'document.pdf', 1);

    // Verify DeleteObjectCommand was called
    const calls = s3Mock.commandCalls(DeleteObjectCommand);
    expect(calls.length).toBe(1);

    const command = calls[0]!.args[0]!.input;
    expect(command.Key).toBe(
      'tasks/task-123/artifacts/artifact-456/v1/document.pdf',
    );
  });

  it('should handle S3 deletion errors', async () => {
    s3Mock.on(DeleteObjectCommand).rejects(new Error('S3 error'));

    await expect(
      deleteArtifact('task-123', 'artifact-456', 'document.pdf', 1),
    ).rejects.toThrow('S3 error');
  });
});

describe('deleteArtifactsBatch', () => {
  it('should handle empty array', async () => {
    const result = await deleteArtifactsBatch([]);

    expect(result.deleted).toBe(0);
    expect(result.errors).toBe(0);

    // Should not call S3 at all
    const calls = s3Mock.commandCalls(DeleteObjectsCommand);
    expect(calls.length).toBe(0);
  });

  it('should delete multiple artifacts in batch', async () => {
    s3Mock.on(DeleteObjectsCommand).resolves({
      Deleted: [
        { Key: 'tasks/task-1/artifacts/art-1/v1/file1.txt' },
        { Key: 'tasks/task-1/artifacts/art-2/v1/file2.txt' },
        { Key: 'tasks/task-2/artifacts/art-3/v1/file3.txt' },
      ],
      Errors: [],
    });

    const artifacts = [
      { taskId: 'task-1', artifactId: 'art-1', path: 'file1.txt', version: 1 },
      { taskId: 'task-1', artifactId: 'art-2', path: 'file2.txt', version: 1 },
      { taskId: 'task-2', artifactId: 'art-3', path: 'file3.txt', version: 1 },
    ];

    const result = await deleteArtifactsBatch(artifacts);

    expect(result.deleted).toBe(3);
    expect(result.errors).toBe(0);

    // Verify DeleteObjectsCommand was called once
    const calls = s3Mock.commandCalls(DeleteObjectsCommand);
    expect(calls.length).toBe(1);

    // Verify all artifacts were included
    const command = calls[0]!.args[0]!.input;
    expect(command.Delete?.Objects).toHaveLength(3);
  });

  it('should handle partial deletion errors', async () => {
    s3Mock.on(DeleteObjectsCommand).resolves({
      Deleted: [
        { Key: 'tasks/task-1/artifacts/art-1/v1/file1.txt' },
        { Key: 'tasks/task-1/artifacts/art-2/v1/file2.txt' },
      ],
      Errors: [
        {
          Key: 'tasks/task-2/artifacts/art-3/v1/file3.txt',
          Code: 'InternalError',
          Message: 'S3 internal error',
        },
      ],
    });

    const artifacts = [
      { taskId: 'task-1', artifactId: 'art-1', path: 'file1.txt', version: 1 },
      { taskId: 'task-1', artifactId: 'art-2', path: 'file2.txt', version: 1 },
      { taskId: 'task-2', artifactId: 'art-3', path: 'file3.txt', version: 1 },
    ];

    const result = await deleteArtifactsBatch(artifacts);

    expect(result.deleted).toBe(2);
    expect(result.errors).toBe(1);
  });

  it('should handle >1000 artifacts in multiple batches', async () => {
    // Create 1500 artifacts to test batch splitting
    const artifacts = Array.from({ length: 1500 }, (_, i) => ({
      taskId: `task-${Math.floor(i / 10)}`,
      artifactId: `art-${i}`,
      path: `file-${i}.txt`,
      version: 1,
    }));

    // Mock first batch (1000 items)
    s3Mock
      .on(DeleteObjectsCommand)
      .resolvesOnce({
        Deleted: Array.from({ length: 1000 }, (_, i) => ({
          Key: `tasks/task-${Math.floor(i / 10)}/artifacts/art-${i}/v1/file-${i}.txt`,
        })),
        Errors: [],
      })
      // Mock second batch (500 items)
      .resolvesOnce({
        Deleted: Array.from({ length: 500 }, (_, i) => ({
          Key: `tasks/task-${Math.floor((i + 1000) / 10)}/artifacts/art-${i + 1000}/v1/file-${i + 1000}.txt`,
        })),
        Errors: [],
      });

    const result = await deleteArtifactsBatch(artifacts);

    expect(result.deleted).toBe(1500);
    expect(result.errors).toBe(0);

    // Verify DeleteObjectsCommand was called twice
    const calls = s3Mock.commandCalls(DeleteObjectsCommand);
    expect(calls.length).toBe(2);

    // Verify batch sizes
    expect(calls[0]!.args[0]!.input.Delete?.Objects).toHaveLength(1000);
    expect(calls[1]!.args[0]!.input.Delete?.Objects).toHaveLength(500);
  });

  it('should handle batch deletion with mixed results across batches', async () => {
    const artifacts = Array.from({ length: 1200 }, (_, i) => ({
      taskId: `task-${i}`,
      artifactId: `art-${i}`,
      path: `file-${i}.txt`,
      version: 1,
    }));

    // First batch: 950 deleted, 50 errors
    s3Mock
      .on(DeleteObjectsCommand)
      .resolvesOnce({
        Deleted: Array.from({ length: 950 }, (_, i) => ({
          Key: `key-${i}`,
        })),
        Errors: Array.from({ length: 50 }, (_, i) => ({
          Key: `key-${i + 950}`,
          Code: 'InternalError',
          Message: 'Error',
        })),
      })
      // Second batch: 180 deleted, 20 errors
      .resolvesOnce({
        Deleted: Array.from({ length: 180 }, (_, i) => ({
          Key: `key-${i + 1000}`,
        })),
        Errors: Array.from({ length: 20 }, (_, i) => ({
          Key: `key-${i + 1180}`,
          Code: 'InternalError',
          Message: 'Error',
        })),
      });

    const result = await deleteArtifactsBatch(artifacts);

    expect(result.deleted).toBe(1130); // 950 + 180
    expect(result.errors).toBe(70); // 50 + 20

    const calls = s3Mock.commandCalls(DeleteObjectsCommand);
    expect(calls.length).toBe(2);
  });

  it('should handle undefined Deleted and Errors arrays', async () => {
    s3Mock.on(DeleteObjectsCommand).resolves({
      Deleted: undefined,
      Errors: undefined,
    });

    const artifacts = [
      { taskId: 'task-1', artifactId: 'art-1', path: 'file1.txt', version: 1 },
    ];

    const result = await deleteArtifactsBatch(artifacts);

    // Should handle undefined gracefully
    expect(result.deleted).toBe(0);
    expect(result.errors).toBe(0);
  });

  it('should propagate S3 command errors', async () => {
    s3Mock.on(DeleteObjectsCommand).rejects(new Error('S3 connection failed'));

    const artifacts = [
      { taskId: 'task-1', artifactId: 'art-1', path: 'file1.txt', version: 1 },
    ];

    await expect(deleteArtifactsBatch(artifacts)).rejects.toThrow(
      'S3 connection failed',
    );
  });
});
