import { type NextRequest, NextResponse } from 'next/server';

import {
  getAvatarObject,
  isValidAvatarFilename,
  isValidAvatarUserId,
} from '@/lib/server/avatar-storage';

export const runtime = 'nodejs';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ userId: string; filename: string }> },
) {
  const { userId, filename } = await params;

  if (
    !userId ||
    !filename ||
    !isValidAvatarUserId(userId) ||
    !isValidAvatarFilename(filename)
  ) {
    return NextResponse.json(
      { error: 'Invalid avatar request' },
      {
        status: 400,
      },
    );
  }

  let s3Response;
  try {
    s3Response = await getAvatarObject(userId, filename);
  } catch {
    return NextResponse.json({ error: 'Avatar not found' }, { status: 404 });
  }

  if (!s3Response.Body) {
    return NextResponse.json(
      { error: 'Avatar content is empty' },
      {
        status: 502,
      },
    );
  }

  const contentType = s3Response.ContentType ?? 'application/octet-stream';

  // Defense in depth: the upload path only accepts images, but refuse to
  // serve anything that is not an image content type in case an object was
  // written out of band.
  if (!contentType.startsWith('image/')) {
    return NextResponse.json(
      { error: 'Unsupported avatar type' },
      {
        status: 415,
      },
    );
  }

  const webStream = s3Response.Body.transformToWebStream();

  const headers = new Headers({
    'Content-Type': contentType,
    'Cache-Control': 'public, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
  });

  if (s3Response.ContentLength !== undefined) {
    headers.set('Content-Length', String(s3Response.ContentLength));
  }

  return new NextResponse(webStream, {
    status: 200,
    headers,
  });
}
