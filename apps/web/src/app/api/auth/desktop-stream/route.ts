import { NextRequest, NextResponse } from 'next/server';

import {
  createDesktopStreamSession,
  PreviewSessionError,
} from '@/lib/server/preview-session';

export const runtime = 'nodejs';

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const previewUrl = request.nextUrl.searchParams.get('preview_url');
    const runId = request.nextUrl.searchParams.get('task_run_id');
    if (!previewUrl || !runId) {
      return NextResponse.json(
        { error: 'Missing required parameters: preview_url, task_run_id' },
        { status: 400 },
      );
    }

    return NextResponse.json(
      await createDesktopStreamSession({ previewUrl, runId }),
    );
  } catch (error) {
    if (error instanceof PreviewSessionError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status },
      );
    }

    console.error('Desktop stream auth error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}
