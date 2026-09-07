import { NextRequest, NextResponse } from 'next/server';

import {
  authorizeRunToken,
  getArtifactById,
  generateOwnedDownloadUrl,
} from '@/lib/server';

export const runtime = 'nodejs';

// Legacy worker-facing compatibility route. New worker and built-in MCP
// artifact download URL lookups go through apps/api. Remove this once no
// worker callers depend on the web origin for artifact download URLs.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const authResult = await authorizeRunToken(request);

  if (!authResult.success) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;

  if (!id) {
    return NextResponse.json({ error: 'Missing artifact ID' }, { status: 400 });
  }

  // Get artifact with task ID from query params or headers
  const taskId = request.nextUrl.searchParams.get('taskId');

  if (!taskId) {
    return NextResponse.json(
      { error: 'Missing taskId query parameter' },
      { status: 400 },
    );
  }

  // Verify artifact exists and user has access
  const artifact = await getArtifactById({
    taskId,
    artifactId: id,
    auth: {
      userId: authResult.userId,
      isAdmin: authResult.isAdmin,
    },
  });

  if (!artifact) {
    return NextResponse.json(
      { error: 'Artifact not found or access denied' },
      { status: 404 },
    );
  }

  // Check if artifact has been uploaded
  if (!artifact.uploaded) {
    return NextResponse.json(
      { error: 'Artifact has not been uploaded yet' },
      { status: 400 },
    );
  }

  // Generate presigned download URL
  const downloadUrl = await generateOwnedDownloadUrl(
    artifact.taskId
      ? { taskId: artifact.taskId }
      : { sessionId: artifact.sessionId! },
    artifact.id,
    artifact.path,
    artifact.version,
  );

  return NextResponse.json({
    url: downloadUrl,
    path: artifact.path,
    version: artifact.version,
    contentType: artifact.contentType,
    size: artifact.size,
  });
}
