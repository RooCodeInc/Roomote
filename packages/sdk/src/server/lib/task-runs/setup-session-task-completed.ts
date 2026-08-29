import { captureEvent } from '@roomote/telemetry/server';
import {
  normalizeSetupNewState,
  normalizeSetupNewSetupSession,
} from '@roomote/types';
import { and, db, deploymentSettings, eq, sql } from '@roomote/db/server';

const SETUP_SESSION_ADVISORY_LOCK = 'setup-session';

/**
 * Record the "first setup-launched task completed" funnel milestone exactly
 * once, when a settled task belongs to the deployment's conversational setup
 * session. Anonymous analytics only: terminal outcome, no prompts or
 * repository content. Safe to call for every settled Fast child task.
 */
export async function recordSetupSessionTaskCompleted(params: {
  conversationId: string;
  status: string;
}): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${SETUP_SESSION_ADVISORY_LOCK}))`,
    );

    const [settings] = await tx
      .select({ setupNewState: deploymentSettings.setupNewState })
      .from(deploymentSettings)
      .where(and(eq(deploymentSettings.id, 'default')))
      .limit(1);

    const state = normalizeSetupNewState(settings?.setupNewState ?? {});
    const setupSession = normalizeSetupNewSetupSession(state.setupSession);
    if (
      !setupSession ||
      setupSession.conversationId !== params.conversationId
    ) {
      return;
    }
    if (setupSession.milestones.first_task_completed) {
      return;
    }

    await tx
      .update(deploymentSettings)
      .set({
        setupNewState: {
          ...state,
          setupSession: {
            ...setupSession,
            milestones: {
              ...setupSession.milestones,
              first_task_completed: new Date().toISOString(),
            },
          },
        },
        updatedAt: new Date(),
      })
      .where(eq(deploymentSettings.id, 'default'));

    void captureEvent('setup_session_task_completed', {
      properties: { status: params.status },
    });
  });
}
