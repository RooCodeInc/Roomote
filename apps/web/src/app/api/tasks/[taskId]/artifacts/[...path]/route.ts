import { NextRequest, NextResponse } from 'next/server';

import { authorizeRunToken, getArtifactByPath } from '@/lib/server';

export const runtime = 'nodejs';

// Legacy worker-facing compatibility route. New worker and built-in MCP
// artifact metadata lookups by task path go through apps/api. Remove this once
// no worker callers depend on the web origin for artifact metadata.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ taskId: string; path: string[] }> },
) {
  const authResult = await authorizeRunToken(request);

  if (!authResult.success) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { taskId, path } = await params;

  // Parse optional version query param (e.g., ?v=1)
  const versionParam = request.nextUrl.searchParams.get('v');
  const version = versionParam ? parseInt(versionParam, 10) : undefined;

  if (!taskId) {
    return NextResponse.json({ error: 'Missing task ID' }, { status: 400 });
  }

  if (!path || path.length === 0) {
    return NextResponse.json({ error: 'Missing path' }, { status: 400 });
  }

  // Join path segments to handle nested paths
  const artifactPath = path.join('/');

  // Get artifact by path (and optionally version)
  const artifact = await getArtifactByPath({
    taskId,
    path: artifactPath,
    version,
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

  // Return artifact metadata including version
  return NextResponse.json({
    id: artifact.id,
    taskId: artifact.taskId,
    runId: artifact.runId,
    path: artifact.path,
    version: artifact.version,
    contentType: artifact.contentType,
    size: artifact.size,
    uploaded: artifact.uploaded,
    createdAt: artifact.createdAt,
    updatedAt: artifact.updatedAt,
  });
}
