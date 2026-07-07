import { type NextRequest, NextResponse } from 'next/server';

import { authUsers, db, eq, users } from '@roomote/db/server';

import { authorize } from '@/lib/server/auth-context';
import {
  buildAvatarFilename,
  buildAvatarUrl,
  deleteAvatarObjectIfExists,
  isAllowedAvatarContentType,
  isAllowedAvatarSize,
  parseAvatarFilenameFromUrl,
  putAvatarObject,
} from '@/lib/server/avatar-storage';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const authResult = await authorize();

  if (!authResult.success) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const userId = authResult.userId;

  const formData = await request.formData().catch(() => null);

  if (!formData) {
    return NextResponse.json({ error: 'Invalid form data' }, { status: 400 });
  }

  const file = formData.get('file');

  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'Missing image file' }, { status: 400 });
  }

  const contentType = file.type || '';

  if (!isAllowedAvatarContentType(contentType)) {
    return NextResponse.json(
      { error: 'Unsupported image type. Use PNG, JPEG, WebP, or GIF.' },
      { status: 415 },
    );
  }

  if (!isAllowedAvatarSize(file.size)) {
    return NextResponse.json(
      { error: 'Image must be 2 MB or smaller.' },
      { status: 413 },
    );
  }

  const filename = buildAvatarFilename(contentType);
  const bytes = new Uint8Array(await file.arrayBuffer());

  try {
    await putAvatarObject(userId, filename, bytes, contentType);
  } catch {
    return NextResponse.json(
      { error: 'Failed to store image. Try again.' },
      { status: 502 },
    );
  }

  const newUrl = buildAvatarUrl(userId, filename);

  // Read the previous avatar before the write so we can clean it up after the
  // commit succeeds. Doing the cleanup post-commit avoids deleting the old
  // object when the transaction rolls back.
  const [existingUser] = await db
    .select({ imageUrl: users.imageUrl })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  const previousFilename = existingUser
    ? parseAvatarFilenameFromUrl(existingUser.imageUrl, userId)
    : null;

  // Wrap both column writes in a single transaction so a failure cannot leave
  // users.imageUrl and authUsers.image diverged. If the transaction throws, the
  // S3 object we just wrote is orphaned; clean it up before surfacing the 500.
  try {
    await db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({ imageUrl: newUrl, updatedAt: new Date() })
        .where(eq(users.id, userId));

      await tx
        .update(authUsers)
        .set({ image: newUrl })
        .where(eq(authUsers.id, userId));
    });
  } catch {
    await deleteAvatarObjectIfExists(userId, filename);
    return NextResponse.json(
      { error: 'Failed to save profile picture. Try again.' },
      { status: 500 },
    );
  }

  if (previousFilename && previousFilename !== filename) {
    await deleteAvatarObjectIfExists(userId, previousFilename);
  }

  return NextResponse.json({ imageUrl: newUrl });
}

export async function DELETE(_request: NextRequest) {
  const authResult = await authorize();

  if (!authResult.success) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const userId = authResult.userId;

  const [existingUser] = await db
    .select({ imageUrl: users.imageUrl })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  const currentImageUrl = existingUser?.imageUrl ?? '';

  // Only clear avatars that were uploaded through this endpoint. An OAuth
  // provider's avatar URL does not point at /api/avatars/..., so
  // parseAvatarFilenameFromUrl returns null for it and we leave it alone —
  // the user keeps their provider-supplied picture.
  const previousFilename = parseAvatarFilenameFromUrl(currentImageUrl, userId);

  if (!previousFilename) {
    return NextResponse.json(
      { error: 'No uploaded avatar to remove.' },
      { status: 404 },
    );
  }

  try {
    await db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({ imageUrl: '', updatedAt: new Date() })
        .where(eq(users.id, userId));

      await tx
        .update(authUsers)
        .set({ image: null })
        .where(eq(authUsers.id, userId));
    });
  } catch {
    return NextResponse.json(
      { error: 'Failed to remove profile picture. Try again.' },
      { status: 500 },
    );
  }

  await deleteAvatarObjectIfExists(userId, previousFilename);

  return NextResponse.json({ ok: true });
}
