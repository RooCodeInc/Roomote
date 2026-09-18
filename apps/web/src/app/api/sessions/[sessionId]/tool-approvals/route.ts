import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  decideToolCallApproval,
  isDeploymentExperimentEnabled,
  listPendingToolCallApprovals,
  ToolCallApprovalUnavailableError,
} from '@roomote/db/server';
import { toolCallApprovalDecisionSchema } from '@roomote/types';

import { authorize } from '@/lib/server/auth-context';
import { readBoundedJsonBody } from '@/lib/server/bounded-json-body';
import { Env } from '@/lib/server/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const headers = { 'Cache-Control': 'no-store' };
const maxBodyBytes = 4 * 1024;
type Props = { params: Promise<{ sessionId: string }> };

function error(status: number) {
  return NextResponse.json(
    { error: 'Request unavailable' },
    { status, headers },
  );
}

async function handle(request: Request, props: Props, method: 'GET' | 'POST') {
  try {
    const auth = await authorize();
    if (!auth.success || !auth.userId) return error(401);
    const params = z
      .object({ sessionId: z.string().uuid() })
      .safeParse(await props.params);
    if (!params.success) return error(400);
    const context = { sessionId: params.data.sessionId, userId: auth.userId };

    // The disabled experiment keeps the surface inert: no pending records
    // exist, no decisions are accepted, and no execution path changes.
    if (!(await isDeploymentExperimentEnabled('toolApprovals'))) {
      return method === 'GET'
        ? NextResponse.json({ pending: [] }, { headers })
        : error(404);
    }

    if (method === 'GET') {
      return NextResponse.json(
        { pending: await listPendingToolCallApprovals(context) },
        { headers },
      );
    }

    // Only configured public authority is trusted, never caller-supplied proxy headers.
    const ownUrl = new URL(Env.R_PUBLIC_URL ?? Env.R_APP_URL);
    const origin = request.headers.get('origin');
    if (
      !['http:', 'https:'].includes(ownUrl.protocol) ||
      origin !== ownUrl.origin
    ) {
      return error(403);
    }
    if (
      request.headers
        .get('content-type')
        ?.split(';')[0]
        ?.trim()
        .toLowerCase() !== 'application/json'
    ) {
      return error(415);
    }

    const body = await readBoundedJsonBody(request, {
      maxBytes: maxBodyBytes,
      timeoutMs: 10_000,
    });
    if (!body.ok) return error(body.status);
    const args = toolCallApprovalDecisionSchema.safeParse(body.value);
    if (!args.success) return error(400);
    // Requester-only: the decide helper matches the approval's requester,
    // pending state, and expiry window, so a wrong approver, a duplicate
    // response, or an expired ask all fail closed with the same not-found.
    const approval = await decideToolCallApproval(context, args.data);
    return NextResponse.json({ approval }, { status: 200, headers });
  } catch (caught) {
    if (caught instanceof ToolCallApprovalUnavailableError) {
      // Wrong approver, duplicate response, and expired asks share one
      // fail-closed not-found; none of them reveal which check failed.
      return error(404);
    }
    // Never log request values, validation details, or upstream exception messages.
    return error(500);
  }
}

export async function GET(request: Request, props: Props) {
  return handle(request, props, 'GET');
}

export async function POST(request: Request, props: Props) {
  return handle(request, props, 'POST');
}
