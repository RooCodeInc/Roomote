import { and, eq, isNull, ne, or } from 'drizzle-orm';

import { db } from '../db';
import { taskRuns } from '../schema';

/**
 * Sets the live actor from a trusted server-side sender resolution.
 *
 * This must not be exposed through a run-scoped run-token mutation:
 * `task_runs.actingUserId` selects actor-scoped credentials for the sandbox.
 */
export async function setTrustedRunActingUser(params: {
  runId: number;
  userId: string;
}): Promise<void> {
  await db
    .update(taskRuns)
    .set({ actingUserId: params.userId })
    .where(
      and(
        eq(taskRuns.id, params.runId),
        or(
          isNull(taskRuns.actingUserId),
          ne(taskRuns.actingUserId, params.userId),
        ),
      ),
    );
}

/**
 * Runs a short trusted claim while holding the run row lock, then switches
 * the actor only when the claim succeeds. This is used when another store
 * (currently Redis request_user_input queues) atomically decides which
 * sender won: losing contenders must not leave their identity on the run.
 *
 * The callback should be short. Holding the row lock also serializes normal
 * actor updates until the claim and matching actor write commit together.
 */
export async function setTrustedRunActingUserOnSuccess(params: {
  runId: number;
  userId: string;
  operation: () => Promise<boolean>;
}): Promise<boolean> {
  return await db.transaction(async (tx) => {
    const [run] = await tx
      .select({ actingUserId: taskRuns.actingUserId })
      .from(taskRuns)
      .where(eq(taskRuns.id, params.runId))
      .for('update');

    if (!run) {
      throw new Error(
        `Run not found while setting trusted actor: ${params.runId}`,
      );
    }

    const succeeded = await params.operation();

    if (!succeeded || run.actingUserId === params.userId) {
      return succeeded;
    }

    await tx
      .update(taskRuns)
      .set({ actingUserId: params.userId })
      .where(eq(taskRuns.id, params.runId));

    return true;
  });
}

/**
 * Atomically changes the live actor only when it still matches the caller's
 * observed value. The boolean reports whether this call applied the change.
 */
export async function compareAndSetTrustedRunActingUser(params: {
  runId: number;
  expectedUserId: string | null;
  nextUserId: string | null;
}): Promise<boolean> {
  if (params.expectedUserId === params.nextUserId) {
    return false;
  }

  const [updated] = await db
    .update(taskRuns)
    .set({ actingUserId: params.nextUserId })
    .where(
      and(
        eq(taskRuns.id, params.runId),
        params.expectedUserId === null
          ? isNull(taskRuns.actingUserId)
          : eq(taskRuns.actingUserId, params.expectedUserId),
      ),
    )
    .returning({ id: taskRuns.id });

  return Boolean(updated);
}
