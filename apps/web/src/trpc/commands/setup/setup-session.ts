import { randomUUID } from 'node:crypto';

import {
  createFastAgentWebTaskLauncher,
  type FastAgentTurnAdapter,
} from '@roomote/cloud-agents/server';
import {
  db,
  deploymentSettings,
  ensureSessionForFastConversation,
  eq,
  fastAgentConversations,
  sql,
} from '@roomote/db/server';
import {
  createSetupNewSetupSession,
  normalizeSetupNewState,
  normalizeSetupNewSetupSession,
  type SetupNewSetupSession,
  type SetupSessionMilestone,
} from '@roomote/types';
import { captureEvent } from '@roomote/telemetry/server';

import type { UserAuthSuccess } from '@/types';
import {
  SETUP_STARTER_TASKS,
  getSetupStarterTask,
} from '@/lib/setup-starter-tasks';
import { getSourceControlConnectionSummary } from '@/lib/server';
import { assertAdmin } from './shared';
import { completeSetupCommand } from './index';
import {
  scheduleWebFastAgentTurn,
  submitFastSessionUserInputCommand,
} from '../fast-sessions';

const SETUP_SESSION_ADVISORY_LOCK = 'setup-session';

async function readSetupNewState() {
  const [settings] = await db
    .select({ setupNewState: deploymentSettings.setupNewState })
    .from(deploymentSettings)
    .where(eq(deploymentSettings.id, 'default'))
    .limit(1);
  return normalizeSetupNewState(settings?.setupNewState ?? {});
}

async function saveSetupSessionLinkage(
  setupSession: SetupNewSetupSession,
): Promise<void> {
  const state = await readSetupNewState();
  await db
    .update(deploymentSettings)
    .set({
      setupNewState: { ...state, setupSession },
      updatedAt: new Date(),
    })
    .where(eq(deploymentSettings.id, 'default'));
}

async function markSetupSessionMilestoneInState(
  milestone: SetupSessionMilestone,
): Promise<boolean> {
  // Serialize concurrent milestone claims (OAuth return, recommendation
  // events) on the setup advisory lock so exactly one caller schedules the
  // once-only milestone turn.
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${SETUP_SESSION_ADVISORY_LOCK}))`,
    );
    const [settings] = await tx
      .select({ setupNewState: deploymentSettings.setupNewState })
      .from(deploymentSettings)
      .where(eq(deploymentSettings.id, 'default'))
      .limit(1);
    const state = normalizeSetupNewState(settings?.setupNewState ?? {});
    const setupSession = normalizeSetupNewSetupSession(state.setupSession);
    if (!setupSession || setupSession.milestones[milestone]) {
      return false;
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
              [milestone]: new Date().toISOString(),
            },
          },
        },
        updatedAt: new Date(),
      })
      .where(eq(deploymentSettings.id, 'default'));
    return true;
  });
}

/**
 * Trusted, structured setup snapshot injected into every setup-session turn.
 * Contains readiness facts, connected provider/repository counts, starter
 * catalog metadata, recommendation status, and completion state — never
 * credentials, secrets, or prompts.
 */
async function buildSetupSnapshot(): Promise<string> {
  const [state, connectionSummary] = await Promise.all([
    readSetupNewState(),
    getSourceControlConnectionSummary(),
  ]);
  const setupSession = normalizeSetupNewSetupSession(state.setupSession);

  return JSON.stringify({
    sourceControl: {
      connected: connectionSummary.connectedProviders.length > 0,
      connectedProviders: connectionSummary.connectedProviders,
      repositoryCounts: connectionSummary.repositoryCounts,
      totalRepositories: Object.values(
        connectionSummary.repositoryCounts,
      ).reduce((sum, count) => sum + (count ?? 0), 0),
    },
    starterCatalog: SETUP_STARTER_TASKS.map((task) => ({
      id: task.id,
      title: task.title,
      description: task.description,
    })),
    automationRecommendations: state.automationRecommendations
      ? {
          status: state.automationRecommendations.status,
          recommendationCount:
            state.automationRecommendations.recommendations.length,
          applicationState:
            state.automationRecommendations.applicationState ?? 'pending',
        }
      : null,
    setup: {
      sessionCreated: Boolean(setupSession),
      completed: setupSession?.completedAt != null,
      milestones: setupSession ? Object.keys(setupSession.milestones) : [],
    },
  });
}

type SetupSessionConversation = {
  conversationId: string;
  workspaceId: string;
};

async function findSetupSessionConversation(): Promise<SetupSessionConversation | null> {
  const state = await readSetupNewState();
  const setupSession = normalizeSetupNewSetupSession(state.setupSession);
  if (!setupSession) return null;
  const [conversation] = await db
    .select({
      conversationId: fastAgentConversations.conversationId,
      workspaceId: fastAgentConversations.workspaceId,
    })
    .from(fastAgentConversations)
    .where(eq(fastAgentConversations.id, setupSession.conversationId))
    .limit(1);
  return conversation ?? null;
}

function buildSetupSessionWebConversation(
  conversation: SetupSessionConversation,
) {
  return {
    surface: 'web' as const,
    workspaceId: conversation.workspaceId,
    conversationId: conversation.conversationId,
  };
}

function buildSetupSessionAdapterExtensions(
  auth: UserAuthSuccess,
): Partial<FastAgentTurnAdapter> {
  return {
    launchSetupStarterTasks: ({ taskIds }) =>
      launchSetupStarterTasksForSetupSession(auth, taskIds),
  };
}

/** Read-only setup-session info for the setup workspace client. */
export async function getSetupSessionStatusCommand(auth: UserAuthSuccess) {
  assertAdmin(auth);
  const state = await readSetupNewState();
  const setupSession = normalizeSetupNewSetupSession(state.setupSession);
  let ready = false;
  if (setupSession) {
    const [conversation] = await db
      .select({ id: fastAgentConversations.id })
      .from(fastAgentConversations)
      .where(eq(fastAgentConversations.id, setupSession.conversationId))
      .limit(1);
    ready = Boolean(conversation);
  }
  return {
    ready,
    sessionId: setupSession?.sessionId ?? null,
    completed: setupSession?.completedAt != null,
  };
}

/**
 * Reuse the persisted accessible setup session, or create a visible Fast web
 * conversation and unified session titled "Set up Roomote." under the setup
 * advisory lock. The linkage is persisted before the initial turn is
 * scheduled, and Roomote starts with a trusted setup platform event rather
 * than a fake user message.
 */
export async function getOrCreateSetupSessionCommand(
  auth: UserAuthSuccess,
): Promise<{
  sessionId: string;
  conversationId: string;
  created: boolean;
}> {
  assertAdmin(auth);

  const created = await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${SETUP_SESSION_ADVISORY_LOCK}))`,
    );

    const [settings] = await tx
      .select({ setupNewState: deploymentSettings.setupNewState })
      .from(deploymentSettings)
      .where(eq(deploymentSettings.id, 'default'))
      .limit(1);
    const state = normalizeSetupNewState(settings?.setupNewState ?? {});
    const existing = normalizeSetupNewSetupSession(state.setupSession);

    if (existing) {
      const [conversation] = await tx
        .select({ id: fastAgentConversations.id })
        .from(fastAgentConversations)
        .where(eq(fastAgentConversations.id, existing.conversationId))
        .limit(1);
      if (conversation) {
        return { reused: true, setupSession: existing };
      }
    }

    const conversationId = randomUUID();
    await tx.insert(fastAgentConversations).values({
      surface: 'web',
      userId: auth.userId,
      workspaceId: auth.userId,
      conversationId,
      title: 'Set up Roomote.',
    });
    const fastConversation = await tx.query.fastAgentConversations.findFirst({
      where: eq(fastAgentConversations.conversationId, conversationId),
    });
    if (!fastConversation) {
      throw new Error('Failed to create the setup session conversation.');
    }
    const unifiedSession = await ensureSessionForFastConversation(
      tx,
      fastConversation.id,
    );

    const setupSession = createSetupNewSetupSession({
      sessionId: unifiedSession.id,
      conversationId: fastConversation.id,
    });
    await tx
      .update(deploymentSettings)
      .set({
        setupNewState: { ...state, setupSession },
        updatedAt: new Date(),
      })
      .where(eq(deploymentSettings.id, 'default'));

    return { reused: false, setupSession };
  });

  if (!created.reused) {
    void captureEvent('setup_session_created', {
      userId: auth.userId,
      properties: {},
    });

    const conversation = await findSetupSessionConversation();
    if (conversation) {
      await scheduleSetupSessionPlatformTurn({
        auth,
        conversation,
        payload: {
          type: 'setup_session_started',
          guidance:
            'Introduce yourself briefly, build the onboarding agenda with update_plan, and guide the administrator through source control connection before offering starter tasks.',
        },
      });
    }
  }

  return {
    sessionId: created.setupSession.sessionId,
    conversationId: created.setupSession.conversationId,
    created: !created.reused,
  };
}

async function scheduleSetupSessionPlatformTurn({
  auth,
  conversation,
  payload,
}: {
  auth: UserAuthSuccess;
  conversation: SetupSessionConversation;
  payload: Record<string, unknown>;
}): Promise<void> {
  const webConversation = buildSetupSessionWebConversation(conversation);
  scheduleWebFastAgentTurn({
    userId: auth.userId,
    delivery: {
      conversation: webConversation,
      adapter: {
        launchTask: createFastAgentWebTaskLauncher({
          userId: auth.userId,
          conversation: webConversation,
        }),
        postReply: async () => {},
      },
    },
    question: `<platform_event>${JSON.stringify(payload)}</platform_event>`,
    turnSource: 'platform_event',
    platformEventKind: 'setup',
    platformEventVisibility: 'required',
    adapterExtensions: buildSetupSessionAdapterExtensions(auth),
    setupSession: true,
    setupSnapshot: await buildSetupSnapshot(),
  });
}

/**
 * Record a setup-session milestone exactly once and schedule the setup
 * session's next trusted platform turn (OAuth return, recommendation
 * readiness, recommendation apply/skip).
 */
export async function scheduleSetupSessionMilestoneTurn(
  auth: UserAuthSuccess,
  input: {
    milestone: SetupSessionMilestone;
    eventType:
      | 'source_control_connected'
      | 'recommendations_ready'
      | 'recommendations_decided';
  },
): Promise<{ scheduled: boolean }> {
  assertAdmin(auth);
  const inserted = await markSetupSessionMilestoneInState(input.milestone);
  if (!inserted) {
    return { scheduled: false };
  }
  const conversation = await findSetupSessionConversation();
  if (!conversation) {
    return { scheduled: false };
  }
  await scheduleSetupSessionPlatformTurn({
    auth,
    conversation,
    payload: { type: input.eventType },
  });
  return { scheduled: true };
}

/**
 * Launch validated setup starter tasks through the Fast child-task path with
 * `workflow: standard`, `surface: web`, `trigger: message`, visible task
 * state, and Fast delegation linkage. Prompts are resolved server-side from
 * the hardcoded catalog; idempotency keys derive from the setup session's
 * stable batch ID. Setup completes when at least one launch succeeds.
 */
export async function launchSetupStarterTasksForSetupSession(
  auth: UserAuthSuccess,
  taskIds: string[],
): Promise<{
  launched: Array<{ starterTaskId: string; taskId: string }>;
  failed: Array<{ starterTaskId: string; error: string }>;
  setupCompleted: boolean;
}> {
  assertAdmin(auth);
  const state = await readSetupNewState();
  const setupSession = normalizeSetupNewSetupSession(state.setupSession);
  if (!setupSession) {
    throw new Error('The setup session is not initialized.');
  }
  const [conversation] = await db
    .select({
      conversationId: fastAgentConversations.conversationId,
      workspaceId: fastAgentConversations.workspaceId,
    })
    .from(fastAgentConversations)
    .where(eq(fastAgentConversations.id, setupSession.conversationId))
    .limit(1);

  const uniqueTaskIds = [...new Set(taskIds)];
  const launcher = conversation
    ? createFastAgentWebTaskLauncher({
        userId: auth.userId,
        conversation: buildSetupSessionWebConversation(conversation),
      })
    : null;

  const launched: Array<{ starterTaskId: string; taskId: string }> = [];
  const failed: Array<{ starterTaskId: string; error: string }> = [];

  await Promise.all(
    uniqueTaskIds.map(async (taskId) => {
      const starterTask = getSetupStarterTask(
        taskId as Parameters<typeof getSetupStarterTask>[0],
      );
      if (!starterTask) {
        failed.push({
          starterTaskId: taskId,
          error: 'Unknown starter task ID.',
        });
        return;
      }
      if (!launcher) {
        failed.push({
          starterTaskId: taskId,
          error: 'The setup session is no longer available.',
        });
        return;
      }
      try {
        const result = await launcher({
          prompt: starterTask.prompt,
          environmentId: null,
          parentSessionId: setupSession.conversationId,
          launchIdempotencyKey: [
            'setup-starter-session',
            auth.userId,
            setupSession.starterLaunchBatchId,
            taskId,
          ].join(':'),
          postKickoff: async () => {},
        });
        if (result.success) {
          launched.push({ starterTaskId: taskId, taskId: result.taskId });
        } else {
          failed.push({ starterTaskId: taskId, error: result.error });
        }
      } catch (error) {
        failed.push({
          starterTaskId: taskId,
          error:
            error instanceof Error
              ? error.message
              : 'The task could not start.',
        });
      }
    }),
  );

  let setupCompleted = false;
  if (launched.length > 0 && setupSession.completedAt == null) {
    const now = new Date().toISOString();
    await saveSetupSessionLinkage({
      ...setupSession,
      completedAt: now,
      milestones: {
        ...setupSession.milestones,
        first_task_launched: setupSession.milestones.first_task_launched ?? now,
      },
    });
    try {
      await completeSetupCommand(auth);
      setupCompleted = true;
      void captureEvent('setup_session_transitioned', {
        userId: auth.userId,
        properties: {
          launchedCount: launched.length,
          failedCount: failed.length,
        },
      });
    } catch (error) {
      console.error(
        '[Setup Session] Completion after first launch failed:',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  void captureEvent('setup_session_starter_launch', {
    userId: auth.userId,
    properties: {
      launchedCount: launched.length,
      failedCount: failed.length,
      starterTaskIds: uniqueTaskIds.join(','),
      allFailed: launched.length === 0,
    },
  });

  return { launched, failed, setupCompleted };
}

/**
 * Authenticated structured-input response for the setup session, wrapped with
 * the setup-only adapter extensions and snapshot so the resumed turn can
 * continue setup.
 */
export async function submitSetupSessionUserInputCommand(
  auth: UserAuthSuccess,
  input: {
    sessionId: string;
    requestId: string;
    answers: Record<string, { answers: string[] }>;
  },
): Promise<{ success: true }> {
  assertAdmin(auth);
  const state = await readSetupNewState();
  const setupSession = normalizeSetupNewSetupSession(state.setupSession);
  if (!setupSession || input.sessionId !== setupSession.sessionId) {
    throw new Error('This input request does not belong to the setup session.');
  }
  return submitFastSessionUserInputCommand(auth, input, {
    adapterExtensions: buildSetupSessionAdapterExtensions(auth),
    setupSnapshot: await buildSetupSnapshot(),
    setupSession: true,
  });
}
