import { and, asc, desc, eq } from 'drizzle-orm';

import { db, type DatabaseOrTransaction } from '../db';
import { EVAL_RUN_STATUSES, evalRuns } from '../schema';

export { EVAL_RUN_STATUSES };

export type EvalRunStatus = (typeof EVAL_RUN_STATUSES)[number];

export type EvalRunSummaryPhase = {
  label: string;
  durationMs?: number;
  status: 'pass' | 'fail' | 'pending';
};

export type EvalRunReport = {
  ok: boolean;
  startedAt: string;
  finishedAt?: string;
  totalDurationMs?: number;
  error?: string;
  [key: string]: unknown;
};

export function normalizeEvalRunName(evalName: string): string {
  return evalName.trim().toLowerCase().replace(/\s+/g, '-');
}

export async function createEvalRun(
  evalName: string,
  triggeredBy: string,
  options: {
    db?: DatabaseOrTransaction;
  } = {},
): Promise<string> {
  const database = options.db ?? db;
  const [createdRun] = await database
    .insert(evalRuns)
    .values({
      evalName: normalizeEvalRunName(evalName),
      status: 'running',
      triggeredBy,
    })
    .returning({
      id: evalRuns.id,
    });

  if (!createdRun) {
    throw new Error('Failed to create `eval_runs` record.');
  }

  return createdRun.id;
}

export async function finishEvalRun(
  id: string,
  input: {
    status: EvalRunStatus;
    report?: EvalRunReport | null;
    phases?: EvalRunSummaryPhase[] | null;
    durationMs?: number | null;
    error?: string | null;
    finishedAt?: Date | string | null;
  },
  options: {
    db?: DatabaseOrTransaction;
  } = {},
) {
  const database = options.db ?? db;
  const [updatedRun] = await database
    .update(evalRuns)
    .set({
      status: input.status,
      report: input.report ?? null,
      phases: input.phases ?? null,
      durationMs: input.durationMs ?? null,
      error: input.error ?? null,
      finishedAt:
        input.finishedAt instanceof Date
          ? input.finishedAt
          : input.finishedAt
            ? new Date(input.finishedAt)
            : null,
    })
    .where(eq(evalRuns.id, id))
    .returning({
      id: evalRuns.id,
    });

  if (!updatedRun) {
    throw new Error(`Eval run not found: ${id}`);
  }

  return updatedRun;
}

export async function listEvalRuns(
  params: {
    evalName?: string;
    status?: EvalRunStatus;
    limit?: number;
    offset?: number;
  } = {},
  options: {
    db?: DatabaseOrTransaction;
  } = {},
) {
  const database = options.db ?? db;
  const trimmedEvalName = params.evalName?.trim();
  const safeLimit = Math.min(Math.max(params.limit ?? 50, 1), 100);
  const safeOffset = Math.max(params.offset ?? 0, 0);
  const conditions = [];

  if (trimmedEvalName) {
    conditions.push(
      eq(evalRuns.evalName, normalizeEvalRunName(trimmedEvalName)),
    );
  }

  if (params.status) {
    conditions.push(eq(evalRuns.status, params.status));
  }

  return database.query.evalRuns.findMany({
    where: conditions.length > 0 ? and(...conditions) : undefined,
    columns: {
      id: true,
      evalName: true,
      status: true,
      phases: true,
      durationMs: true,
      error: true,
      triggeredBy: true,
      createdAt: true,
      finishedAt: true,
    },
    orderBy: [desc(evalRuns.createdAt), desc(evalRuns.id)],
    limit: safeLimit,
    offset: safeOffset,
  });
}

export async function listEvalRunNames(
  _params: Record<string, never> = {},
  options: {
    db?: DatabaseOrTransaction;
  } = {},
) {
  const database = options.db ?? db;
  const rows = await database
    .selectDistinct({
      evalName: evalRuns.evalName,
    })
    .from(evalRuns)
    .orderBy(asc(evalRuns.evalName));

  return rows.map((row) => row.evalName);
}

export async function getEvalRun(
  id: string,
  _params: Record<string, never> = {},
  options: {
    db?: DatabaseOrTransaction;
  } = {},
) {
  const database = options.db ?? db;
  const conditions = [eq(evalRuns.id, id)];

  return (
    (await database.query.evalRuns.findFirst({
      where: and(...conditions),
      orderBy: desc(evalRuns.createdAt),
    })) ?? null
  );
}
