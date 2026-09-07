import { NextRequest, NextResponse } from 'next/server';
import {
  ARTIFACT_RAW_URL_MAX_AGE_SECONDS,
  currentEpochSeconds,
} from '@roomote/sdk/server';

import {
  getUploadedArtifactById,
  getOwnedArtifactObject,
  verifyArtifactSignature,
} from '@/lib/server';

export const runtime = 'nodejs';

const ALLOWED_PUBLIC_CONTENT_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'video/webm',
]);

/** Never cache longer than this, and never past remaining signature / TTL. */
const RAW_RESPONSE_CACHE_MAX_AGE_SECONDS = 3600;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  if (!id) {
    return NextResponse.json({ error: 'Missing artifact ID' }, { status: 400 });
  }

  // Verify HMAC signature (requires both sig and ts params)
  const sig = request.nextUrl.searchParams.get('sig');
  const tsParam = request.nextUrl.searchParams.get('ts');

  if (!sig || !tsParam) {
    return NextResponse.json(
      { error: 'Invalid or missing signature' },
      { status: 403 },
    );
  }

  const ts = Number(tsParam);

  if (!Number.isFinite(ts) || ts <= 0) {
    return NextResponse.json(
      { error: 'Invalid or missing signature' },
      { status: 403 },
    );
  }

  if (!verifyArtifactSignature(id, sig, ts)) {
    return NextResponse.json(
      { error: 'Invalid or missing signature' },
      { status: 403 },
    );
  }

  // Look up artifact -- only uploaded artifacts are returned
  const artifact = await getUploadedArtifactById(id);

  if (!artifact) {
    return NextResponse.json({ error: 'Artifact not found' }, { status: 404 });
  }

  // Only serve explicitly allowlisted content types publicly
  if (!ALLOWED_PUBLIC_CONTENT_TYPES.has(artifact.contentType)) {
    return NextResponse.json(
      { error: 'Only allowlisted artifact types can be served publicly' },
      { status: 403 },
    );
  }

  // Fetch the object from S3
  let s3Response;
  try {
    s3Response = await getOwnedArtifactObject(
      artifact.taskId
        ? { taskId: artifact.taskId }
        : { sessionId: artifact.sessionId! },
      artifact.id,
      artifact.path,
      artifact.version,
    );
  } catch {
    return NextResponse.json(
      { error: 'Failed to retrieve artifact content' },
      { status: 502 },
    );
  }

  if (!s3Response.Body) {
    return NextResponse.json(
      { error: 'Artifact content is empty' },
      { status: 502 },
    );
  }

  // Convert the S3 readable stream to a Web ReadableStream
  const webStream = s3Response.Body.transformToWebStream();
  const remainingTtlSeconds = Math.max(
    0,
    ARTIFACT_RAW_URL_MAX_AGE_SECONDS - (currentEpochSeconds() - ts),
  );
  const cacheMaxAge = Math.min(
    RAW_RESPONSE_CACHE_MAX_AGE_SECONDS,
    remainingTtlSeconds,
  );

  const headers = new Headers({
    'Content-Type': artifact.contentType,
    'Cache-Control': `public, max-age=${cacheMaxAge}, immutable`,
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
