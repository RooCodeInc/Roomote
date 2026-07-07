import { NextRequest, NextResponse } from 'next/server';

import {
  getUploadedArtifactById,
  getArtifactObject,
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
    s3Response = await getArtifactObject(
      artifact.taskId,
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

  const headers = new Headers({
    'Content-Type': artifact.contentType,
    'Cache-Control': 'public, max-age=86400, immutable',
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
