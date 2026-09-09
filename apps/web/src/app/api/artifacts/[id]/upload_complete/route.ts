import { NextRequest, NextResponse } from 'next/server';

import { and, db, taskArtifacts, eq } from '@roomote/db/server';

import { authorizeRunToken } from '@/lib/server';
import { canAccessTask } from '@/lib/server/custom-automation-task-access';

export const runtime = 'nodejs';

// Legacy worker-facing compatibility route. New worker and built-in MCP
// upload-complete callbacks go through apps/api. Remove this once no worker
// callers depend on the web origin for upload completion.
export async function POST(
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

  // Get taskId from query params for access verification
  const taskId = request.nextUrl.searchParams.get('taskId');

  if (!taskId) {
    return NextResponse.json(
      { error: 'Missing taskId query parameter' },
      { status: 400 },
    );
  }

  // Upload completion requires write access, not the artifact helper's read access.
  if (!(await canAccessTask(authResult, taskId))) {
    return NextResponse.json(
      { error: 'Artifact not found or access denied' },
      { status: 404 },
    );
  }

  // Verify artifact exists and user has access
  const artifact = await db.query.taskArtifacts.findFirst({
    where: and(eq(taskArtifacts.taskId, taskId), eq(taskArtifacts.id, id)),
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
