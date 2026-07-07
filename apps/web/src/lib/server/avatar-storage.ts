import {
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';

import { Env } from '@/lib/server/env';
import { getS3Client } from '@/lib/server/s3-client';

const ALLOWED_AVATAR_CONTENT_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

const MAX_AVATAR_BYTES = 2 * 1024 * 1024; // 2 MB

const CONTENT_TYPE_TO_EXTENSION: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

function getExtensionForContentType(contentType: string): string | null {
  return CONTENT_TYPE_TO_EXTENSION[contentType] ?? null;
}

export function isAllowedAvatarContentType(contentType: string): boolean {
  return ALLOWED_AVATAR_CONTENT_TYPES.has(contentType);
}

export function isAllowedAvatarSize(size: number): boolean {
  return size > 0 && size <= MAX_AVATAR_BYTES;
}

function getAvatarKeyPrefix(userId: string): string {
  return `avatars/${userId}/`;
}

// Filename shape: avatar-{epochMs}.{ext}. The version component busts
// browser/CDN caches on re-upload without needing a separate version column.
function getAvatarKey(userId: string, filename: string): string {
  return `${getAvatarKeyPrefix(userId)}${filename}`;
}

export function buildAvatarFilename(contentType: string): string {
  const ext = getExtensionForContentType(contentType);

  if (!ext) {
    throw new Error(`Unsupported avatar content type: ${contentType}`);
  }

  return `avatar-${Date.now()}.${ext}`;
}

// Validates the dynamic route segment so a caller cannot traverse outside the
// user's avatar prefix or request a non-image object.
export function isValidAvatarFilename(filename: string): boolean {
  return /^avatar-\d+\.(png|jpg|webp|gif)$/.test(filename);
}

// Rejects userIds containing path separators or traversal sequences. Auth user
// ids are opaque UUID-like strings, so any `/`, `\`, or `..` is invalid.
export function isValidAvatarUserId(userId: string): boolean {
  if (!userId || userId.length > 128) {
    return false;
  }

  if (/[\\/]|^\.\.|\.\.(?:\/|$)/.test(userId)) {
    return false;
  }

  return true;
}

// Relative URL resolved against the app origin by the browser. Stored in
// users.imageUrl / auth_users.image so every Avatar surface reflects it.
export function buildAvatarUrl(userId: string, filename: string): string {
  return `/api/avatars/${encodeURIComponent(userId)}/${filename}`;
}

export async function putAvatarObject(
  userId: string,
  filename: string,
  body: Uint8Array | Buffer,
  contentType: string,
): Promise<void> {
  const command = new PutObjectCommand({
    Bucket: Env.S3_BUCKET_ARTIFACTS,
    Key: getAvatarKey(userId, filename),
    Body: body,
    ContentType: contentType,
  });

  await getS3Client().send(command);
}

export async function getAvatarObject(userId: string, filename: string) {
  const command = new GetObjectCommand({
    Bucket: Env.S3_BUCKET_ARTIFACTS,
    Key: getAvatarKey(userId, filename),
  });

  return getS3Client().send(command);
}

async function deleteAvatarObject(
  userId: string,
  filename: string,
): Promise<void> {
  const command = new DeleteObjectCommand({
    Bucket: Env.S3_BUCKET_ARTIFACTS,
    Key: getAvatarKey(userId, filename),
  });

  await getS3Client().send(command);
}

// Best-effort cleanup of a previous avatar object after a re-upload or
// removal. Failures here must not block the user-facing write.
export async function deleteAvatarObjectIfExists(
  userId: string,
  filename: string,
): Promise<void> {
  if (!filename || !isValidAvatarFilename(filename)) {
    return;
  }

  try {
    await deleteAvatarObject(userId, filename);
  } catch {
    // Swallow: a stale object left in the bucket is harmless and a later
    // removal or overwrite will reclaim the key.
  }
}

export function parseAvatarFilenameFromUrl(
  imageUrl: string,
  userId: string,
): string | null {
  const prefix = `/api/avatars/${encodeURIComponent(userId)}/`;

  if (!imageUrl.startsWith(prefix)) {
    return null;
  }

  const filename = imageUrl.slice(prefix.length).split('?')[0] ?? '';

  return isValidAvatarFilename(filename) ? filename : null;
}
