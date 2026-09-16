import { NextRequest } from 'next/server';
import { createResponse } from 'better-sse';
import { z } from 'zod';

import {
  db,
  desc,
  eq,
  sql,
  taskMessages,
  taskRuns,
  tasks,
} from '@roomote/db/server';

import { getTaskMessageEnvelopePage } from '@/lib/server';
import { withApiV1Auth } from '@/lib/server/api-v1';
import { requireTaskReadAccess } from '@/lib/server/custom-automation-task-access';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STREAM_MAX_MS = 60 * 60 * 1_000;
const POLL_INTERVAL_MS = 1_000;
const INITIAL_CURSOR_OVERLAP_MS = 60_000;
const PAGE_LIMIT = 200;

/**
 * Server-side live view of a task for native clients: the same envelopes the
 * transcript endpoint serves, pushed as they land, plus task/run state. The
 * web client subscribes to the sandbox directly over a tRPC WebSocket; this
 * bridge keeps the app off sandbox internals and mirrors the Session stream.
 */
export const GET = withApiV1Auth<{ id: string }>(
  async ({ request, auth, params }) => {
    const taskId = params.id;
    await requireTaskReadAccess(auth, taskId);

    const sinceParam = z.coerce
      .number()
      .int()
      .nonnegative()
      .safeParse(request.nextUrl.searchParams.get('since') ?? undefined);
    let cursorMs = sinceParam.success
      ? sinceParam.data
      : Date.now() - INITIAL_CURSOR_OVERLAP_MS;
    let lastStateSignature: string | undefined;

    return createResponse(request as NextRequest, async (sseSession) => {
      const startTime = Date.now();
      while (startTime + STREAM_MAX_MS > Date.now()) {
        if (!sseSession.isConnected) break;
        try {
          const [newest] = await db
            .select({
              maxCreatedAtMs: sql<number>`coalesce(max(extract(epoch from ${taskMessages.createdAt}) * 1000), 0)`,
              count: sql<number>`count(*)`,
            })
            .from(taskMessages)
            .where(
              sql`${taskMessages.taskId} = ${taskId} and extract(epoch from ${taskMessages.createdAt}) * 1000 > ${cursorMs}`,
            );
          if (Number(newest?.count ?? 0) > 0) {
            // Rows are keyset-paged newest-first; one page covers a burst.
            const page = await getTaskMessageEnvelopePage({
              taskId,
              limit: PAGE_LIMIT,
            });
            const fresh = page.messages.filter(
              (envelope) => envelope.createdAt > cursorMs,
            );
            cursorMs = Math.max(cursorMs, Number(newest?.maxCreatedAtMs ?? 0));
            if (fresh.length > 0) {
              await sseSession.push({ messages: fresh }, 'messages');
            }
          }

          const [state] = await db
            .select({
              state: tasks.state,
              title: tasks.title,
              runId: taskRuns.id,
              runStatus: taskRuns.status,
              runPhase: taskRuns.taskPhase,
            })
            .from(tasks)
            .leftJoin(taskRuns, eq(taskRuns.taskId, tasks.id))
            .where(eq(tasks.id, taskId))
            .orderBy(desc(taskRuns.id))
            .limit(1);
          const signature = JSON.stringify(state ?? null);
          if (signature !== lastStateSignature) {
            lastStateSignature = signature;
            await sseSession.push(
              {
                state: state?.state ?? null,
                title: state?.title ?? null,
                latestRun: state?.runId
                  ? {
                      id: state.runId,
                      status: state.runStatus,
                      phase: state.runPhase,
                    }
                  : null,
              },
              'task',
            );
          }
        } catch {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }
      if (sseSession.isConnected) {
        try {
          await sseSession.push(null, 'disconnect');
        } catch {
          // Client already gone.
        }
      }
    });
  },
);
