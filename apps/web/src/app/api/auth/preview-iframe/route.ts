import { NextRequest, NextResponse } from 'next/server';
import {
  createPreviewSession,
  PreviewSessionError,
} from '@/lib/server/preview-session';

export const runtime = 'nodejs';

/**
 * Same-origin trampoline for iframe-based preview authentication.
 *
 * The iframe's initial `src` points here (same origin as the parent page),
 * so app session cookies are sent. This endpoint:
 * 1. Authenticates the user via the app auth context
 * 2. Validates access to the cloud job
 * 3. Generates a preview auth token
 * 4. Redirects to the preview URL with an inline `__preview_token`
 *
 * The preview-proxy validates the inline token, translates it into a
 * `preview_auth` cookie on the preview origin, and then strips the token from
 * the browser-visible URL. This keeps the initial auth bootstrap same-origin
 * while avoiding cross-site cookie issues for preview iframes.
 */
export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const previewUrl = searchParams.get('preview_url');
    const cloudJobId = searchParams.get('cloud_job_id');
    if (!previewUrl || !cloudJobId) {
      return NextResponse.json(
        { error: 'Missing required parameters: preview_url, cloud_job_id' },
        { status: 400 },
      );
    }

    const session = await createPreviewSession({
      cloudJobId,
      previewUrl,
    });

    return NextResponse.redirect(session.httpUrl);
  } catch (error) {
    if (error instanceof PreviewSessionError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status },
      );
    }

    console.error('Preview iframe auth error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}
