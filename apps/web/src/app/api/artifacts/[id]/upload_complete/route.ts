import { NextRequest, NextResponse } from 'next/server';

import { db, taskArtifacts, eq } from '@roomote/db/server';

import { authorizeJobToken, getArtifactById } from '@/lib/server';

export const runtime = 'nodejs';

// Legacy worker-facing compatibility route. New worker and built-in MCP
// upload-complete callbacks go through apps/api. Remove this once no worker
// callers depend on the web origin for upload completion.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const authResult = await authorizeJobToken(request);

  if (!authResult.success) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;

  if (!id) {
    return NextResponse.json({ error: 'Missing artifact ID' }, { status: 400 });
  }

  // Get taskId from query params for access verification
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

  // Update artifact to mark as uploaded
  await db
    .update(taskArtifacts)
    .set({
      uploaded: true,
      updatedAt: new Date(),
    })
    .where(eq(taskArtifacts.id, id));

  return new NextResponse(null, { status: 200 });
}
