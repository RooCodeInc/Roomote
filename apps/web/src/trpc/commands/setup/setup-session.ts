import { createHash } from 'node:crypto';

import { type FastAgentTurnAdapter } from '@roomote/cloud-agents/server';
import {
  and,
  db,
  deploymentSettings,
  ensureSessionForFastConversation,
  eq,
  fastAgentConversations,
  fastAgentMessages,
  gte,
  sessions,
  sql,
  taskRuns,
  users,
} from '@roomote/db/server';
import {
  ACP_ENVELOPE_EVENT_TYPES,
  AUTOMATION_RECOMMENDATION_CATALOG,
  createSetupNewSetupSession,
  isSetupStarterTaskId,
  normalizeSetupNewState,
  normalizeSetupNewSetupSession,
  RunStatus,
  type AcpRequestUserInputAnswers,
  type AcpRequestUserInputPayload,
  type AutomationRecommendationBatch,
  type SetupStarterTaskId,
} from '@roomote/types';
import { captureEvent } from '@roomote/telemetry/server';

import type { UserAuthSuccess } from '@/types';
import { SETUP_STARTER_TASKS } from '@/lib/setup-starter-tasks';
import { assertAdmin } from './shared';
import { completeSetupCommand } from './index';
import { getSetupNewStatusCommand } from '../setup-new';
import {
  buildSetupReceiptMessage,
  formatComputeReadinessReceipt,
  formatRecommendationApplicationReceipt,
  formatSourceConnectionReceipt,
  formatStarterSelectionReceipt,
  type SetupReceiptKind,
} from './setup-receipts';
import {
  scheduleWebFastAgentTurn,
  submitFastSessionUserInputCommand,
} from '../fast-sessions';

const SETUP_SESSION_ADVISORY_LOCK = 'setup-session';
const SETUP_SESSION_TITLE = 'Set up Roomote';

type SetupPlatformEventKind =
  | 'session_creation'
  | 'provider_selection'
  | 'source_connection'
  | 'starter_request'
  | 'compute_readiness'
  | 'starter_selection'
  | 'recommendation_readiness';

type SetupSessionConversation = {
  fastConversationId: string;
  sessionId: string;
  conversationId: string;
  workspaceId: string;
  workflowVersion: number;
};

function hasSynchronizedSourceControl(
  status: Awaited<ReturnType<typeof getSetupNewStatusCommand>>,
): boolean {
  return status.sourceControlSetup.providers.some(
    (provider) => provider.connected && (provider.repositoryCount ?? 0) > 0,
  );
}

async function assertSetupStarterWorkReady(
  auth: UserAuthSuccess,
  options: { requireStarterSelection?: boolean; requireCompute?: boolean } = {},
): Promise<void> {
  const status = await getSetupNewStatusCommand(auth);
  if (!hasSynchronizedSourceControl(status)) {
    throw new Error(
      'Connect source control and sync at least one repository before choosing or starting work.',
    );
  }

  const setupSession = normalizeSetupNewSetupSession(
    status.setupNewState.setupSession,
  );
  if (options.requireStarterSelection && !setupSession?.starterTaskSelection) {
    throw new Error('Choose your first work before starting a task.');
  }
  if (options.requireCompute && !status.computeSetup.setupSatisfied) {
    throw new Error('Set up a sandbox before starting work.');
  }
}

async function readSetupNewState() {
  const [settings] = await db
    .select({ setupNewState: deploymentSettings.setupNewState })
    .from(deploymentSettings)
    .where(eq(deploymentSettings.id, 'default'))
    .limit(1);
  return normalizeSetupNewState(settings?.setupNewState ?? {});
}

async function findSetupSessionConversation(
  auth: UserAuthSuccess,
): Promise<SetupSessionConversation | null> {
  const state = await readSetupNewState();
  const setupSession = normalizeSetupNewSetupSession(state.setupSession);
  if (!setupSession) return null;

  const [row] = await db
    .select({
      fastConversationId: fastAgentConversations.id,
      sessionId: sessions.id,
      conversationId: fastAgentConversations.conversationId,
      workspaceId: fastAgentConversations.workspaceId,
    })
    .from(sessions)
    .innerJoin(
      fastAgentConversations,
      eq(sessions.fastConversationId, fastAgentConversations.id),
    )
    .where(
      and(
        eq(sessions.id, setupSession.sessionId),
        eq(fastAgentConversations.userId, auth.userId),
      ),
    )
    .limit(1);
  return row ? { ...row, workflowVersion: setupSession.workflowVersion } : null;
}

async function persistSetupSessionReceipt(
  auth: UserAuthSuccess,
  input: {
    kind: SetupReceiptKind;
    fingerprint: string;
    text: string;
    payload?: Record<string, unknown>;
    ts?: number;
  },
  conversation?: SetupSessionConversation,
): Promise<boolean> {
  const setupConversation =
    conversation ?? (await findSetupSessionConversation(auth));
  if (!setupConversation) return false;

  const receipt = buildSetupReceiptMessage({
    sessionId: setupConversation.sessionId,
    workflowVersion: setupConversation.workflowVersion,
    userId: auth.userId,
    ...input,
  });
  const inserted = await db
    .insert(fastAgentMessages)
    .values({
      conversationId: setupConversation.fastConversationId,
      ...receipt,
    })
    .onConflictDoNothing({
      target: [fastAgentMessages.conversationId, fastAgentMessages.eventId],
    })
    .returning({ id: fastAgentMessages.id });

  // Deliberately do not call appendFastAgentVisibleMessages: canonical history
  // renders this receipt, while model/OpenCode compatibility history remains
  // authoritative structured setup events only.
  return inserted.length > 0;
}

function buildSetupEventTurnId(input: {
  sessionId: string;
  workflowVersion: number;
  kind: SetupPlatformEventKind;
  fingerprint: string;
}): string {
  const digest = createHash('sha256')
    .update(
      `${input.sessionId}:v${input.workflowVersion}:${input.kind}:${input.fingerprint}`,
    )
    .digest('hex')
    .slice(0, 24);
  return `setup:${input.kind}:${digest}`;
}

function buildSetupSnapshot(input: {
  status: Awaited<ReturnType<typeof getSetupNewStatusCommand>>;
  hasSuccessfulStarterLaunch: boolean;
}): string {
  const state = normalizeSetupNewState(input.status.setupNewState);
  const setupSession = normalizeSetupNewSetupSession(state.setupSession);
  const repositoryCount = input.status.sourceControlSetup.providers.reduce(
    (total, provider) => total + (provider.repositoryCount ?? 0),
    0,
  );

  return JSON.stringify({
    rail: deriveSetupRailMilestones(input.status),
    sourceControl: {
      selectedProvider: state.sourceControlProvider,
      connectedProviders: input.status.sourceControlSetup.providers
        .filter((provider) => provider.connected)
        .map((provider) => provider.provider),
      repositoryCount,
    },
    starterSelection: setupSession?.starterTaskSelection ?? null,
    starterLaunch: {
      hasSuccessfulLaunch: input.hasSuccessfulStarterLaunch,
    },
    recommendations: state.automationRecommendations
      ? {
          fingerprint: state.automationRecommendations.inputFingerprint,
          status: state.automationRecommendations.status,
          recommendationCount:
            state.automationRecommendations.recommendations.length,
          applicationState:
            state.automationRecommendations.applicationState ?? 'pending',
        }
      : null,
  });
}

async function resolveSetupSnapshot(auth: UserAuthSuccess): Promise<string> {
  const status = await getSetupNewStatusCommand(auth);
  const setupSession = normalizeSetupNewSetupSession(
    status.setupNewState.setupSession,
  );
  return buildSetupSnapshot({
    status,
    hasSuccessfulStarterLaunch: setupSession?.starterTaskSelection
      ? await hasSuccessfulSetupSessionTaskLaunch(
          auth,
          setupSession.starterTaskSelection.selectedAt,
        )
      : false,
  });
}

async function hasSuccessfulSetupSessionTaskLaunch(
  auth: UserAuthSuccess,
  selectedAt: string,
): Promise<boolean> {
  const conversation = await findSetupSessionConversation(auth);
  if (!conversation) return false;
  const [run] = await db
    .select({ id: taskRuns.id })
    .from(taskRuns)
    .where(
      and(
        eq(taskRuns.fastAgentSessionId, conversation.fastConversationId),
        gte(taskRuns.createdAt, new Date(selectedAt)),
        sql`${taskRuns.status} NOT IN (${RunStatus.Failed}, ${RunStatus.Canceled})`,
      ),
    )
    .limit(1);
  return Boolean(run);
}

function deriveSetupRailMilestones(
  status: Awaited<ReturnType<typeof getSetupNewStatusCommand>>,
) {
  const state = normalizeSetupNewState(status.setupNewState);
  const setupSession = normalizeSetupNewSetupSession(state.setupSession);
  const selectedComputeProvider = state.computeProvider;
  const provisioning = selectedComputeProvider
    ? selectedComputeProvider === 'e2b'
      ? state.e2bTemplateBuild
      : selectedComputeProvider === 'daytona'
        ? state.daytonaSnapshotBuild
        : selectedComputeProvider === 'blaxel'
          ? state.blaxelImageBuild
          : selectedComputeProvider === 'azure'
            ? state.azureDiskImageBuild
            : null
    : null;
  const computeReady = status.computeSetup.setupSatisfied;
  const sourceConnected = hasSynchronizedSourceControl(status);

  return {
    account: 'ready' as const,
    inference: status.modelSetup.setupSatisfied
      ? 'ready'
      : ('pending' as const),
    compute: computeReady
      ? ('ready' as const)
      : provisioning?.status === 'building'
        ? ('preparing' as const)
        : ('pending' as const),
    source: sourceConnected ? ('ready' as const) : ('pending' as const),
    firstWork: setupSession?.starterTaskSelection
      ? ('ready' as const)
      : ('pending' as const),
    open: !sourceConnected,
  };
}

async function buildSetupSessionAdapterExtensions(
  auth: UserAuthSuccess,
): Promise<Partial<FastAgentTurnAdapter>> {
  return {
    resolveUserInputPreset: async (preset) => {
      if (preset !== 'setup_starter_tasks') {
        throw new Error('Unsupported setup input preset.');
      }
      await assertSetupStarterWorkReady(auth);
      return [
        {
          id: 'setup-starter-tasks',
          header: 'First work',
          question: 'What should Roomote work on first?',
          isOther: false,
          isSecret: false,
          multiple: true,
          options: SETUP_STARTER_TASKS.map((task) => ({
            label: task.id,
            description: `${task.title}: ${task.description}`,
          })),
        },
      ];
    },
    assertTaskLaunch: () =>
      assertSetupStarterWorkReady(auth, {
        requireStarterSelection: true,
        requireCompute: true,
      }),
  };
}

export async function scheduleSetupPlatformEvent(
  auth: UserAuthSuccess,
  input: {
    kind: SetupPlatformEventKind;
    fingerprint: string;
    payload: Record<string, unknown>;
  },
): Promise<{ scheduled: boolean }> {
  const turn = await buildSetupPlatformEventTurn(auth, input);
  if (!turn) return { scheduled: false };
  scheduleWebFastAgentTurn(turn);
  return { scheduled: true };
}

async function buildSetupPlatformEventTurn(
  auth: UserAuthSuccess,
  input: {
    kind: SetupPlatformEventKind;
    fingerprint: string;
    payload: Record<string, unknown>;
  },
  prepared?: {
    conversation: SetupSessionConversation;
    setupSnapshot: string;
  },
): Promise<Parameters<typeof scheduleWebFastAgentTurn>[0] | null> {
  assertAdmin(auth);
  const conversation =
    prepared?.conversation ?? (await findSetupSessionConversation(auth));
  if (!conversation) return null;

  const currentMessageId = buildSetupEventTurnId({
    sessionId: conversation.sessionId,
    workflowVersion: conversation.workflowVersion,
    kind: input.kind,
    fingerprint: input.fingerprint,
  });
  return {
    userId: auth.userId,
    delivery: {
      conversation: {
        surface: 'web',
        workspaceId: conversation.workspaceId,
        conversationId: conversation.conversationId,
      },
      adapter: {
        launchTask: (
          await import('@roomote/cloud-agents/server')
        ).createFastAgentWebTaskLauncher({
          userId: auth.userId,
          conversation: {
            surface: 'web',
            workspaceId: conversation.workspaceId,
            conversationId: conversation.conversationId,
          },
        }),
        postReply: async () => {},
      },
    },
    question: `<platform_event>${JSON.stringify({
      type: input.kind,
      ...input.payload,
    })}</platform_event>`,
    turnSource: 'platform_event',
    platformEventKind: 'setup',
    platformEventVisibility: 'required',
    currentMessageId,
    skipIfTurnCompleted: {
      conversationId: conversation.fastConversationId,
      turnId: currentMessageId,
    },
    adapterExtensions: await buildSetupSessionAdapterExtensions(auth),
    setupSession: true,
    setupSnapshot:
      prepared?.setupSnapshot ?? (await resolveSetupSnapshot(auth)),
  };
}

/**
 * Callers must await this while inside the current Next request scope because
 * each scheduled event registers its Fast turn through `after()`.
 */
export async function reconcileSetupPlatformEvents(
  auth: UserAuthSuccess,
): Promise<void> {
  assertAdmin(auth);
  const status = await getSetupNewStatusCommand(auth);
  const state = normalizeSetupNewState(status.setupNewState);
  const setupSession = normalizeSetupNewSetupSession(state.setupSession);
  if (!setupSession) return;
  const conversation = await findSetupSessionConversation(auth);
  if (!conversation) return;
  const hasSuccessfulStarterLaunch = setupSession.starterTaskSelection
    ? await hasSuccessfulSetupSessionTaskLaunch(
        auth,
        setupSession.starterTaskSelection.selectedAt,
      )
    : false;
  const setupSnapshot = buildSetupSnapshot({
    status,
    hasSuccessfulStarterLaunch,
  });

  const connected = status.sourceControlSetup.providers.filter(
    (provider) => provider.connected,
  );
  const synchronized = connected.filter(
    (provider) => (provider.repositoryCount ?? 0) > 0,
  );
  if (synchronized.length > 0) {
    const repositoryCount = synchronized.reduce(
      (total, provider) => total + (provider.repositoryCount ?? 0),
      0,
    );
    const fingerprint = synchronized
      .map((provider) => provider.provider)
      .sort()
      .join(',');
    await persistSetupSessionReceipt(
      auth,
      {
        kind: 'source_connection',
        fingerprint,
        text: formatSourceConnectionReceipt({
          providerLabels: synchronized.map((provider) => provider.label),
          repositoryCount,
        }),
        payload: {
          providers: synchronized.map((provider) => ({
            provider: provider.provider,
            repositoryCount: provider.repositoryCount ?? 0,
          })),
        },
      },
      conversation,
    );
  }
  if (state.computeProvider && status.computeSetup.setupSatisfied) {
    const providerLabel =
      status.computeSetup.providers.find(
        (provider) => provider.provider === state.computeProvider,
      )?.label ?? state.computeProvider;
    await persistSetupSessionReceipt(
      auth,
      {
        kind: 'compute_readiness',
        fingerprint: state.computeProvider,
        text: formatComputeReadinessReceipt(providerLabel),
        payload: { provider: state.computeProvider },
      },
      conversation,
    );
  }

  const events: Array<Parameters<typeof scheduleSetupPlatformEvent>[1]> = [
    {
      kind: 'session_creation',
      fingerprint: setupSession.startedAt,
      payload: { startedAt: setupSession.startedAt },
    },
  ];
  if (state.computeProvider) {
    events.push({
      kind: 'compute_readiness',
      fingerprint: `${state.computeProvider}:${status.computeSetup.setupSatisfied}`,
      payload: {
        provider: state.computeProvider,
        ready: status.computeSetup.setupSatisfied,
      },
    });
  }
  if (state.sourceControlProvider) {
    events.push({
      kind: 'provider_selection',
      fingerprint: state.sourceControlProvider,
      payload: { provider: state.sourceControlProvider },
    });
  }
  if (connected.length > 0) {
    events.push({
      kind: 'source_connection',
      fingerprint: connected
        .map(
          (provider) => `${provider.provider}:${provider.repositoryCount ?? 0}`,
        )
        .sort()
        .join(','),
      payload: {
        providers: connected.map((provider) => ({
          provider: provider.provider,
          repositoryCount: provider.repositoryCount ?? 0,
        })),
      },
    });
  }
  // The source-connection turn may already have closed without requesting the
  // trusted starter choices. A dedicated, stable event both owns that action
  // for new sessions and repairs existing sessions on their next reconcile.
  if (synchronized.length > 0 && !setupSession.starterTaskSelection) {
    events.push({
      kind: 'starter_request',
      fingerprint: `v${setupSession.workflowVersion}:setup_starter_tasks`,
      payload: {
        repositoryCount: synchronized.reduce(
          (total, provider) => total + (provider.repositoryCount ?? 0),
          0,
        ),
      },
    });
  }
  // Selecting starter work records durable intent, but task launch waits until
  // a sandbox provider is actually usable. This keeps the setup conversation
  // available without allowing a task to enter the queue with no worker
  // backend. A later compute save/provisioning completion re-runs reconciliation
  // and emits this same event once the provider is ready.
  if (setupSession.starterTaskSelection && status.computeSetup.setupSatisfied) {
    events.push({
      kind: 'starter_selection',
      fingerprint: setupSession.starterTaskSelection.requestId,
      payload: {
        requestId: setupSession.starterTaskSelection.requestId,
        starterTasks: setupSession.starterTaskSelection.taskIds.map((id) => {
          const task = SETUP_STARTER_TASKS.find(
            (candidate) => candidate.id === id,
          )!;
          return task;
        }),
      },
    });
  }
  if (
    hasSuccessfulStarterLaunch &&
    state.automationRecommendations?.status === 'ready'
  ) {
    events.push({
      kind: 'recommendation_readiness',
      fingerprint: state.automationRecommendations.inputFingerprint,
      payload: {
        recommendationCount:
          state.automationRecommendations.recommendations.length,
      },
    });
  }

  for (const event of events) {
    const turn = await buildSetupPlatformEventTurn(auth, event, {
      conversation,
      setupSnapshot,
    });
    if (turn) scheduleWebFastAgentTurn(turn);
  }
}

export async function notifySetupSourceControlSynchronized(
  auth: UserAuthSuccess,
): Promise<void> {
  const state = await readSetupNewState();
  if (!normalizeSetupNewSetupSession(state.setupSession)) return;
  const status = await getSetupNewStatusCommand(auth);
  const repositoryCount = status.sourceControlSetup.providers.reduce(
    (total, provider) => total + (provider.repositoryCount ?? 0),
    0,
  );
  if (repositoryCount === 0) return;

  const { startSetupRecommendationsCommand } = await import('../setup-new');
  await startSetupRecommendationsCommand(auth);
  await reconcileSetupPlatformEvents(auth);
}

export async function persistSetupRecommendationApplicationReceipt(
  auth: UserAuthSuccess,
  batch: AutomationRecommendationBatch | null,
  action: 'saved' | 'skipped',
): Promise<void> {
  if (!batch) return;
  const enabledRecommendations = batch.recommendations.filter(
    (recommendation) => recommendation.enabled,
  );
  const enabledTitles = enabledRecommendations.map(
    (recommendation) =>
      AUTOMATION_RECOMMENDATION_CATALOG.find(
        (candidate) => candidate.id === recommendation.candidateId,
      )?.title ?? recommendation.candidateId,
  );
  await persistSetupSessionReceipt(auth, {
    kind: 'recommendation_application',
    fingerprint: `${batch.inputFingerprint}:${action}`,
    text: formatRecommendationApplicationReceipt({ action, enabledTitles }),
    payload: {
      action,
      recommendationIds: enabledRecommendations.map(
        (recommendation) => recommendation.id,
      ),
    },
  });
}

export async function findDeploymentSetupSessionId(): Promise<string | null> {
  return (
    normalizeSetupNewSetupSession((await readSetupNewState()).setupSession)
      ?.sessionId ?? null
  );
}

export async function getSetupSessionStatusCommand(auth: UserAuthSuccess) {
  assertAdmin(auth);
  const status = await getSetupNewStatusCommand(auth);
  const setupSession = normalizeSetupNewSetupSession(
    status.setupNewState.setupSession,
  );
  if (setupSession) await reconcileSetupPlatformEvents(auth);
  return {
    ready: Boolean(await findSetupSessionConversation(auth)),
    sessionId: setupSession?.sessionId ?? null,
    completed: status.setupCompletedAt != null,
    rail: deriveSetupRailMilestones(status),
  };
}

export async function getOrCreateSetupSessionCommand(
  auth: UserAuthSuccess,
): Promise<{ sessionId: string; created: boolean }> {
  assertAdmin(auth);
  const status = await getSetupNewStatusCommand(auth);
  if (!status.modelSetup.setupSatisfied) {
    throw new Error(
      'Inference must be ready before setup can continue in a Session.',
    );
  }

  const result = await db.transaction(async (tx) => {
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
      const [session] = await tx
        .select({ id: sessions.id })
        .from(sessions)
        .innerJoin(
          fastAgentConversations,
          eq(sessions.fastConversationId, fastAgentConversations.id),
        )
        .where(
          and(
            eq(sessions.id, existing.sessionId),
            eq(fastAgentConversations.userId, auth.userId),
          ),
        )
        .limit(1);
      if (session) return { sessionId: session.id, created: false };
    }

    const identity = `setup:first-admin:${auth.userId}`;
    let [conversation] = await tx
      .select()
      .from(fastAgentConversations)
      .where(
        and(
          eq(fastAgentConversations.surface, 'web'),
          eq(fastAgentConversations.workspaceId, auth.userId),
          eq(fastAgentConversations.conversationId, identity),
        ),
      )
      .limit(1);
    if (!conversation) {
      [conversation] = await tx
        .insert(fastAgentConversations)
        .values({
          surface: 'web',
          userId: auth.userId,
          workspaceId: auth.userId,
          conversationId: identity,
          title: SETUP_SESSION_TITLE,
          titleEditedByUserAt: new Date(),
        })
        .returning();
    }
    if (!conversation) throw new Error('Failed to create the setup Session.');

    const session = await ensureSessionForFastConversation(tx, conversation.id);
    await tx
      .update(sessions)
      .set({ title: SETUP_SESSION_TITLE, titleEditedByUserAt: new Date() })
      .where(eq(sessions.id, session.id));
    await tx
      .update(deploymentSettings)
      .set({
        setupNewState: {
          ...state,
          setupSession: createSetupNewSetupSession({ sessionId: session.id }),
        },
        updatedAt: new Date(),
      })
      .where(eq(deploymentSettings.id, 'default'));
    return { sessionId: session.id, created: true };
  });

  if (result.created) {
    void captureEvent('setup_session_created', {
      userId: auth.userId,
      properties: {},
    });
  }
  await reconcileSetupPlatformEvents(auth);
  return result;
}

async function persistSetupPresetResponse(input: {
  auth: UserAuthSuccess;
  fastConversationId: string;
  request: {
    eventId: string;
    turnId: string;
    payload: AcpRequestUserInputPayload;
  };
  answers: AcpRequestUserInputAnswers;
}): Promise<{ completedSetup: boolean }> {
  assertAdmin(input.auth);
  const preset = input.request.payload.preset;
  if (preset !== 'setup_starter_tasks') {
    throw new Error('The setup starter-task preset is missing.');
  }
  await assertSetupStarterWorkReady(input.auth);

  let completedSetup = false;
  await db.transaction(async (tx) => {
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
    const [session] = setupSession
      ? await tx
          .select({ fastConversationId: sessions.fastConversationId })
          .from(sessions)
          .where(eq(sessions.id, setupSession.sessionId))
          .limit(1)
      : [];
    if (
      !setupSession ||
      session?.fastConversationId !== input.fastConversationId
    ) {
      throw new Error('This request does not belong to the setup Session.');
    }

    const responseEventId = `${input.request.eventId}:response`;
    const [existingResponse] = await tx
      .select({ id: fastAgentMessages.id })
      .from(fastAgentMessages)
      .where(
        and(
          eq(fastAgentMessages.conversationId, input.fastConversationId),
          eq(fastAgentMessages.eventId, responseEventId),
        ),
      )
      .limit(1);
    if (existingResponse)
      throw new Error('This input request was already resolved.');

    const taskIds = [
      ...new Set(
        input.answers['setup-starter-tasks']?.answers.filter(
          isSetupStarterTaskId,
        ) ?? [],
      ),
    ] as SetupStarterTaskId[];
    if (taskIds.length === 0) {
      throw new Error('Select at least one starter task.');
    }
    const selectedAt = new Date();
    const nextState = {
      ...state,
      setupSession: {
        ...setupSession,
        starterTaskSelection: {
          requestId: input.request.payload.requestId,
          taskIds,
          selectedAt: selectedAt.toISOString(),
        },
      },
    };
    await tx
      .update(users)
      .set({ onboardingCompletedAt: selectedAt })
      .where(eq(users.id, input.auth.userId));
    completedSetup = true;

    const now = new Date();
    await tx
      .update(deploymentSettings)
      .set({
        setupNewState: nextState,
        ...(completedSetup ? { setupCompletedAt: now } : {}),
        updatedAt: now,
      })
      .where(eq(deploymentSettings.id, 'default'));
    await tx.insert(fastAgentMessages).values({
      conversationId: input.fastConversationId,
      eventId: responseEventId,
      turnId: input.request.turnId,
      turnSeq: 2_000_000_000,
      ts: Date.now(),
      eventType: ACP_ENVELOPE_EVENT_TYPES.RequestUserInputResponse,
      role: 'user',
      contentBlocks: [
        {
          type: 'text',
          text: JSON.stringify({
            requestId: input.request.payload.requestId,
            answers: input.answers,
          }),
        },
      ],
      // The transcript client needs this control event to resolve and remove
      // the input card. FastSessionTranscript filters response event types
      // from rendered chat, so it remains visually hidden.
      metadata: { visibleInTranscript: true },
      payload: {
        requestId: input.request.payload.requestId,
        sessionId: input.fastConversationId,
        turnId: input.request.turnId,
        callId: input.request.payload.callId,
        answers: input.answers,
        resolution: 'submitted',
      },
      source: 'web',
    });
    await tx
      .insert(fastAgentMessages)
      .values({
        conversationId: input.fastConversationId,
        ...buildSetupReceiptMessage({
          sessionId: setupSession.sessionId,
          workflowVersion: setupSession.workflowVersion,
          userId: input.auth.userId,
          kind: 'starter_selection',
          fingerprint: input.request.payload.requestId,
          text: formatStarterSelectionReceipt(
            taskIds.map(
              (taskId) =>
                SETUP_STARTER_TASKS.find((task) => task.id === taskId)!.title,
            ),
          ),
          payload: { taskIds },
          ts: now.getTime(),
        }),
      })
      .onConflictDoNothing({
        target: [fastAgentMessages.conversationId, fastAgentMessages.eventId],
      });
  });

  if (completedSetup) {
    queueMicrotask(() => void completeSetupCommand(input.auth));
  }
  return { completedSetup };
}

export async function submitSetupSessionUserInputCommand(
  auth: UserAuthSuccess,
  input: {
    sessionId: string;
    requestId: string;
    answers: Record<string, { answers: string[] }>;
  },
): Promise<{ success: true }> {
  assertAdmin(auth);
  const setupConversation = await findSetupSessionConversation(auth);
  if (
    !setupConversation ||
    (input.sessionId !== setupConversation.sessionId &&
      input.sessionId !== setupConversation.fastConversationId)
  ) {
    throw new Error('This input request does not belong to the setup Session.');
  }
  return submitFastSessionUserInputCommand(auth, input, {
    adapterExtensions: await buildSetupSessionAdapterExtensions(auth),
    setupSnapshot: await resolveSetupSnapshot(auth),
    setupSession: true,
    persistSetupPresetResponse: async (details) => {
      const result = await persistSetupPresetResponse({ auth, ...details });
      await reconcileSetupPlatformEvents(auth);
      return result;
    },
  });
}
