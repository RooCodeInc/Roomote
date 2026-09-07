import { NextRequest, NextResponse } from 'next/server';

import {
  authorizeRunToken,
  getArtifactById,
  generateDownloadUrl,
} from '@/lib/server';

export const runtime = 'nodejs';

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

  // Get artifact with task ID from query params
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

  // Build response with artifact metadata
  const response: {
    id: string;
    taskId: string;
    runId: number | null;
    path: string;
    version: number;
    contentType: string;
    size: number;
    uploaded: boolean;
    createdAt: Date;
    updatedAt: Date;
    downloadUrl?: string;
  } = {
    id: artifact.id,
    taskId: artifact.taskId!,
    runId: artifact.runId,
    path: artifact.path,
    version: artifact.version,
    contentType: artifact.contentType,
    size: artifact.size,
    uploaded: artifact.uploaded,
    createdAt: artifact.createdAt,
    updatedAt: artifact.updatedAt,
  };

  // Include download URL if artifact has been uploaded
  if (artifact.uploaded) {
    response.downloadUrl = await generateDownloadUrl(
      artifact.taskId!,
      artifact.id,
      artifact.path,
      artifact.version,
    );
  }

  return NextResponse.json(response);
}
