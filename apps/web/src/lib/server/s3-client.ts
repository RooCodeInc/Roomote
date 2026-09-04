import { basename } from 'path';

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  getArtifactStorageKey,
  type ArtifactStorageOwner,
} from '@roomote/types';

import { Env } from '@/lib/server/env';

const PRESIGNED_URL_EXPIRY = 3600; // 1 hour

// Lazy initialization to avoid importing Env at module level
// This prevents errors when the module is imported by client-side code
let s3ClientInstance: S3Client | null = null;
let s3PresignClientInstance: S3Client | null = null;

function createS3Client(endpoint: string): S3Client {
  return new S3Client({
    endpoint,
    region: Env.S3_REGION,
    credentials: {
      accessKeyId: Env.S3_ACCESS_KEY_ID,
      secretAccessKey: Env.S3_SECRET_ACCESS_KEY,
    },
    forcePathStyle: true,
  });
}

function getS3Client(): S3Client {
  s3ClientInstance ??= createS3Client(Env.S3_ENDPOINT);
  return s3ClientInstance;
}

export { getS3Client };

function getS3PresignClient(): S3Client {
  s3PresignClientInstance ??= createS3Client(
    Env.S3_PRESIGN_ENDPOINT ?? Env.S3_ENDPOINT,
  );
  return s3PresignClientInstance;
}

export function getArtifactKey(
  taskId: string,
  artifactId: string,
  path: string,
  version: number,
): string {
  return getArtifactStorageKey({ taskId }, artifactId, path, version);
}

function getOwnedArtifactKey(
  owner: ArtifactStorageOwner,
  artifactId: string,
  path: string,
  version: number,
): string {
  return getArtifactStorageKey(owner, artifactId, path, version);
}

export async function generateUploadUrl(
  taskId: string,
  artifactId: string,
  path: string,
  version: number,
  contentType: string,
  size: number,
): Promise<string> {
  const command = new PutObjectCommand({
    Bucket: Env.S3_BUCKET_ARTIFACTS,
    Key: getArtifactKey(taskId, artifactId, path, version),
    ContentType: contentType,
    ContentLength: size,
  });

  return getSignedUrl(getS3PresignClient(), command, {
    expiresIn: PRESIGNED_URL_EXPIRY,
  });
}

export async function generateDownloadUrl(
  taskId: string,
  artifactId: string,
  path: string,
  version: number,
): Promise<string> {
  return generateOwnedDownloadUrl({ taskId }, artifactId, path, version);
}

export async function generateOwnedDownloadUrl(
  owner: ArtifactStorageOwner,
  artifactId: string,
  path: string,
  version: number,
): Promise<string> {
  // Extract filename for Content-Disposition header
  const filename = basename(path);

  const command = new GetObjectCommand({
    Bucket: Env.S3_BUCKET_ARTIFACTS,
    Key: getOwnedArtifactKey(owner, artifactId, path, version),
    ResponseContentDisposition: `attachment; filename="${filename}"`,
  });

  return getSignedUrl(getS3PresignClient(), command, {
    expiresIn: PRESIGNED_URL_EXPIRY,
  });
}

/**
 * Fetch raw artifact content from S3.
 * Returns the S3 response with Body stream, ContentType, and ContentLength.
 */
export async function getOwnedArtifactObject(
  owner: ArtifactStorageOwner,
  artifactId: string,
  path: string,
  version: number,
) {
  const command = new GetObjectCommand({
    Bucket: Env.S3_BUCKET_ARTIFACTS,
    Key: getOwnedArtifactKey(owner, artifactId, path, version),
  });

  return getS3Client().send(command);
}

/**
 * Delete a single artifact from S3.
 */
export async function deleteArtifact(
  taskId: string,
  artifactId: string,
  path: string,
  version: number,
): Promise<void> {
  const command = new DeleteObjectCommand({
    Bucket: Env.S3_BUCKET_ARTIFACTS,
    Key: getArtifactKey(taskId, artifactId, path, version),
  });

  await getS3Client().send(command);
}

/**
 * Delete multiple artifacts from S3 in a batch.
 * S3 allows up to 1000 objects per batch delete request.
 */
export async function deleteArtifactsBatch(
  artifacts: Array<{
    taskId: string;
    artifactId: string;
    path: string;
    version: number;
  }>,
): Promise<{ deleted: number; errors: number }> {
  if (artifacts.length === 0) {
    return { deleted: 0, errors: 0 };
  }

  // S3 DeleteObjects has a limit of 1000 objects per request
  const BATCH_SIZE = 1000;
  let totalDeleted = 0;
  let totalErrors = 0;

  for (let i = 0; i < artifacts.length; i += BATCH_SIZE) {
    const batch = artifacts.slice(i, i + BATCH_SIZE);

    const command = new DeleteObjectsCommand({
      Bucket: Env.S3_BUCKET_ARTIFACTS,
      Delete: {
        Objects: batch.map((artifact) => ({
          Key: getArtifactKey(
            artifact.taskId,
            artifact.artifactId,
            artifact.path,
            artifact.version,
          ),
        })),
        Quiet: false, // Return info about deleted objects
      },
    });

    const result = await getS3Client().send(command);
    totalDeleted += result.Deleted?.length ?? 0;
    totalErrors += result.Errors?.length ?? 0;
  }

  return { deleted: totalDeleted, errors: totalErrors };
}
