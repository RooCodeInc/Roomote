import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import {
  and,
  db,
  eq,
  isNotNull,
  slackInstallations,
  taskPullRequests,
} from '@roomote/db/server';

import {
  RunStatus,
  TASK_SURFACES,
  TASK_TRIGGERS,
  TASK_VISIBILITIES,
  TASK_WORKFLOWS,
  TaskPayloadKind,
  runEventSources,
  runEventTypes,
  taskSpecSchema,
  communicationProviderSchema,
  getCommunicationChannelFromTaskPayload,
  getCommunicationProviderFromTaskPayload,
  getCommunicationThreadIdFromTaskPayload,
  computeProviderLaunchModes,
  computeProviderUsageLifecycleActions,
  environmentSetupStates,
  doneRunStatuses,
  queuedCommunicationMessageSchema,
  snapshotResumeSchema,
  sourceControlProviderSchema,
  ROOMOTE_RUNTIME_TASK_MESSAGE_PROTOCOL,
  LLM_USAGE_COST_SOURCES,
  type AcpPersistedEnvelope,
} from '@roomote/types';
import {
  getCommunicationMessages,
  queueCommunicationMessage,
} from '@roomote/communication/messages';
import {
  clearPendingCommunicationRequestUserInput,
  getCommunicationRequestUserInputAnswers,
  getCommunicationRequestUserInputConversationId,
  getPendingCommunicationRequestUserInput,
  queueCommunicationRequestUserInputAnswer,
  setPendingCommunicationRequestUserInput,
} from '@roomote/communication/request-user-input';
import {
  enqueueTask,
  type EnqueueTaskInput,
} from '@roomote/cloud-agents/server';
import {
  clearPendingSlackRequestUserInput,
  getSlackThreadFooterText as buildSlackThreadFooterText,
  getSlackStartedMessageData,
  getSlackMessages,
  getSlackRequestUserInputAnswers,
  queueSlackMessage,
  queueSlackRequestUserInputAnswer,
  setPendingSlackRequestUserInput,
} from '@roomote/slack';
import {
  agentSessionEventPayloadSchema,
  clearPendingLinearRequestUserInput,
  getLinearMessages,
  getLinearRequestUserInputAnswers,
  queueLinearMessage,
  queueLinearRequestUserInputAnswer,
  setPendingLinearRequestUserInput,
} from '@roomote/linear';
import { publishCommunicationRequestUserInput } from '../lib/communication-request-user-input';
import {
  authenticatedProcedure,
  isRunToken,
  runScoped,
  userOnlyProcedure,
  router,
} from '../trpc';

import {
  findTaskRun,
  findTaskRunRuntimeState,
  clearCommunicationAckReaction,
  updateTaskRun,
  updateTaskRunRuntimeState,
  touchTaskRunHeartbeat,
  dequeueTaskRun,
  dequeueResumeTaskRun,
  finishRun,
  revertPrCommit,
  createSnapshot,
  refreshGitHubTokenWithMetadata,
  fetchSnapshotEnv,
  recordTaskRunEvent,
  stampTaskRunMilestone,
  taskRunMilestoneFields,
  updateTaskRunEnvironmentSetup,
  recordTaskMessageEnvelope,
  recordTaskInferenceUsage,
  recordComputeProviderUsage,
  getMessageSources,
  setTaskHarnessSessionId,
  enqueueSlackPrInactivityCheck,
  getResolvedRuntimeEnvVars,
  getResolvedGitAuthor,
  findTaskRunByRunTokenClaims,
  claimShowWidgetFallbackDelivery,
  releaseShowWidgetFallbackDelivery,
} from '../lib/task-runs';
import {
  findSlackConversationSubjectByUserId,
  recordSlackConversationMessageBestEffort,
} from '../lib/slack-conversation-log';

const runtimePersistedEnvelopeSchema = z
  .object({
    ts: z.number(),
    eventType: z
      .string()
      .regex(
        /^roomote_runtime\./,
        'eventType must start with "roomote_runtime."',
      ),
    role: z.enum(['user', 'assistant', 'system', 'tool']).nullable(),
    protocol: z.literal(ROOMOTE_RUNTIME_TASK_MESSAGE_PROTOCOL),
    contentBlocks: z.array(z.unknown()),
    metadata: z.record(z.string(), z.unknown()).nullable(),
    payload: z.record(z.string(), z.unknown()),
    logicalEventId: z.string().optional(),
    visibleInTranscript: z.boolean().optional(),
  })
  .transform((envelope) => envelope as AcpPersistedEnvelope);

const acpRequestUserInputQuestionOptionSchema = z.object({
  label: z.string(),
  description: z.string(),
});

const acpRequestUserInputQuestionSchema = z.object({
  id: z.string(),
  header: z.string(),
  question: z.string(),
  isOther: z.boolean(),
  isSecret: z.boolean(),
  options: z.array(acpRequestUserInputQuestionOptionSchema).optional(),
});

const acpRequestUserInputAnswersSchema = z.record(
  z.object({
    answers: z.array(z.string()),
  }),
);

/**
 * Launch-time initiator union. Mirrors the TaskInitiator discriminated shape:
 * a 'user' initiator is either a linked user id or a raw external identity
 * (optionally matched to a user), and an 'automation' initiator carries the
 * automation key plus an optional external actor for context. There is no raw
 * userId/attribution passthrough — attribution derives from this union only.
 */
const taskInitiatorSchema = z.union([
  z.object({
    kind: z.literal('user'),
    userId: z.string().min(1),
  }),
  z.object({
    kind: z.literal('user'),
    externalId: z.string().min(1),
    displayName: z.string().optional(),
    matchedUserId: z.string().optional(),
  }),
  z.object({
    kind: z.literal('automation'),
    key: z.string().min(1),
    actor: z
      .object({
        externalId: z.string().min(1),
        displayName: z.string().optional(),
      })
      .optional(),
  }),
]);

const taskChannelBindingsSchema = z.object({
  slackChannelId: z.string().nullish(),
  slackThreadTs: z.string().nullish(),
  linearSessionId: z.string().nullish(),
  linearIssueId: z.string().nullish(),
  linearOrganizationId: z.string().nullish(),
});

const taskPrLinkageSchema = z.object({
  provider: sourceControlProviderSchema,
  host: z.string().nullish(),
  repositoryId: z.string().uuid().nullish(),
  repository: z.string().min(1),
  prNumber: z.number().int().positive(),
  prUrl: z.string().min(1),
  prTitle: z.string().nullish(),
  prSha: z.string().nullish(),
  prBaseRef: z.string().nullish(),
  prBaseSha: z.string().nullish(),
  githubReactionId: z.number().nullish(),
  githubCheckRunId: z.number().nullish(),
  githubReviewCommentId: z.number().nullish(),
});

/**
 * A fresh launch creates a task (initiator stamp, classification, channel
 * bindings, optional PR linkage) plus its first run.
 */
const freshEnqueueInputSchema = z.object({
  task: taskSpecSchema.refine(
    (task) => task.type !== TaskPayloadKind.SnapshotResume,
    { message: 'Snapshot resumes must use the resume input shape.' },
  ),
  initiator: taskInitiatorSchema,
  workflow: z.enum(TASK_WORKFLOWS),
  surface: z.enum(TASK_SURFACES),
  trigger: z.enum(TASK_TRIGGERS),
  visibility: z.enum(TASK_VISIBILITIES).optional(),
  channels: taskChannelBindingsSchema.optional(),
  prLinkage: taskPrLinkageSchema.optional(),
});

/**
 * A resume attaches a new run to the source run's task. It never creates a
 * task and never re-attributes; the resumer becomes the run's actingUserId.
 */
const resumeEnqueueInputSchema = z.object({
  task: snapshotResumeSchema,
  actingUserId: z.string().nullish(),
});

const enqueueTaskInputSchema = z.union([
  freshEnqueueInputSchema,
  resumeEnqueueInputSchema,
]);

const workerReleaseMetadataSchema = z.object({
  workerReleaseTag: z.string().optional(),
  workerVersion: z.string().optional(),
  workerCommit: z.string().optional(),
});

function runTokenOnlyScoped<T extends z.ZodType>(
  schema: T,
  extractRunId: keyof z.infer<T> | ((input: z.infer<T>) => number),
) {
  return authenticatedProcedure
    .input(schema)
    .use(async ({ ctx, input, next }) => {
      if (!isRunToken(ctx.auth)) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'This endpoint is only available to run tokens',
        });
      }

      const targetId =
        typeof extractRunId === 'function'
          ? extractRunId(input)
          : (input as Record<string, unknown>)[extractRunId as string];

      if (targetId !== ctx.auth.runId) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Cannot access resources from a different run',
        });
      }

      const scopedRun = await findTaskRunByRunTokenClaims(ctx.auth);

      if (!scopedRun) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Cannot access resources from a different run',
        });
      }

      return next({ ctx: { ...ctx, runId: ctx.auth.runId } });
    });
}

export const taskRunsRouter = router({
  findFirstById: runScoped(z.number(), (id) => id).query(({ input }) =>
    findTaskRun(input),
  ),
  // Narrow snapshot for worker polling loops; avoids fetching large columns
  // (payload, prompt, result) every few seconds per active sandbox.
  findRuntimeStateById: runScoped(z.number(), (id) => id).query(({ input }) =>
    findTaskRunRuntimeState(input),
  ),
  update: runScoped(
    z.object({
      id: z.number(),
      status: z.nativeEnum(RunStatus).optional(),
      taskPhase: z.string().nullish(),
      sleepAt: z.date().nullish(),
      // `taskId` is intentionally NOT writable here. This mutation is
      // reachable with a run-scoped run token (held by the sandbox runtime),
      // and a run's task binding is what attribution, visibility, and PR
      // linkage hang off of. Letting the sandbox re-point its run at a
      // different task would corrupt run->task integrity; runs are bound to a
      // task at enqueue time and never re-parented. No worker code path sends
      // this field.
      // `actingUserId` is intentionally NOT writable here either. This
      // mutation is reachable with a run-scoped run token, which the sandbox
      // runtime holds. `task_runs.actingUserId` feeds actor-scoped credential
      // resolution (resolveActorScopedUserContext -> userApiKeys /
      // mcpConnections), so letting a run token set it would be a confused
      // deputy: a compromised sandbox could point the run at an arbitrary
      // user and read that user's decrypted keys / connections. Acting-user
      // reassignment is reserved for trusted server-side writers (web steer
      // in apps/web sandbox-session, pre-delivery sync in
      // apps/api sendMessageToTask and the webhook queue sites), which write
      // task_runs directly. Both fields sent by a run-token caller are
      // stripped by this schema.
      result: z.record(z.unknown()).optional(),
    }),
    'id',
  ).mutation(({ input: { id, ...values } }) => updateTaskRun(id, values)),
  updateRuntimeState: runScoped(
    z.object({
      id: z.number(),
      taskPhase: z.string().nullish(),
      sleepAt: z.date().nullish(),
    }),
    'id',
  ).mutation(({ input: { id, taskPhase, sleepAt } }) =>
    updateTaskRunRuntimeState(id, {
      taskPhase: taskPhase ?? null,
      sleepAt: sleepAt ?? null,
    }),
  ),
  touchTaskRunHeartbeat: runScoped(
    z.object({
      id: z.number(),
      heartbeatAt: z.date().nullish(),
    }),
    'id',
  ).mutation(({ input: { id, heartbeatAt } }) =>
    touchTaskRunHeartbeat(id, heartbeatAt ?? new Date()),
  ),
  stampMilestone: runScoped(
    z.object({
      runId: z.number(),
      field: z.enum(taskRunMilestoneFields),
      at: z.date().nullish(),
      launchMode: z.enum(computeProviderLaunchModes).optional(),
    }),
    'runId',
  ).mutation(({ input: { runId, field, at, launchMode } }) =>
    stampTaskRunMilestone({
      runId,
      field,
      at: at ?? undefined,
      launchMode,
    }),
  ),
  updateEnvironmentSetup: runScoped(
    z.object({
      runId: z.number(),
      state: z.enum(environmentSetupStates),
      completedAt: z.date().nullish(),
    }),
    'runId',
  ).mutation(({ input: { runId, state, completedAt } }) =>
    updateTaskRunEnvironmentSetup({
      runId,
      state,
      completedAt: completedAt ?? undefined,
    }),
  ),
  enqueue: userOnlyProcedure
    .input(enqueueTaskInputSchema)
    .mutation(async ({ input }) => {
      const launchResult = await enqueueTask(input as EnqueueTaskInput);

      return {
        id: launchResult.id,
        taskId: launchResult.taskId,
      };
    }),
  dequeue: runScoped(
    z.object({ runId: z.number() }).merge(workerReleaseMetadataSchema),
    'runId',
  ).mutation(({ ctx, input }) => dequeueTaskRun(ctx.auth, input)),
  resume: runScoped(
    z.object({ runId: z.number() }).merge(workerReleaseMetadataSchema),
    'runId',
  ).mutation(({ ctx, input }) => dequeueResumeTaskRun(ctx.auth, input)),
  done: runScoped(
    z.object({
      id: z.number(),
      status: z.enum(doneRunStatuses),
      error: z.string().optional(),
    }),
    'id',
  ).mutation(({ input }) => finishRun(input)),
  recordEvent: runScoped(
    z.object({
      runId: z.number(),
      source: z.enum(runEventSources),
      eventType: z.enum(runEventTypes),
      message: z.string().optional(),
      details: z.record(z.unknown()).optional(),
    }),
    'runId',
  ).mutation(({ input }) => recordTaskRunEvent(input)),
  recordMessageEnvelope: runTokenOnlyScoped(
    z.object({
      runId: z.number(),
      taskId: z.string(),
      envelope: runtimePersistedEnvelopeSchema,
    }),
    'runId',
  ).mutation(({ ctx, input }) => {
    // Deployment-principal run tokens carry no human user; leave the
    // attribution unset so the envelope persists without a user id.
    const userId =
      'userId' in ctx.auth ? (ctx.auth.userId ?? undefined) : undefined;

    return recordTaskMessageEnvelope({
      runId: input.runId,
      taskId: input.taskId,
      userId,
      envelope: input.envelope,
    });
  }),
  recordInferenceUsage: runTokenOnlyScoped(
    z.object({
      runId: z.number(),
      harnessSessionId: z.string(),
      messageId: z.string(),
      providerId: z.string().nullable().optional(),
      modelId: z.string().nullable().optional(),
      agent: z.string().nullable().optional(),
      inputTokens: z.number().int().nonnegative().nullable().optional(),
      outputTokens: z.number().int().nonnegative().nullable().optional(),
      reasoningTokens: z.number().int().nonnegative().nullable().optional(),
      cacheReadTokens: z.number().int().nonnegative().nullable().optional(),
      cacheWriteTokens: z.number().int().nonnegative().nullable().optional(),
      totalTokens: z.number().int().nonnegative().nullable().optional(),
      contextTokens: z.number().int().nonnegative().nullable().optional(),
      costMicroUsd: z.number().int().nonnegative().nullable().optional(),
      costSource: z.enum(LLM_USAGE_COST_SOURCES).nullable().optional(),
      messageCreatedAt: z.date().nullable().optional(),
      messageCompletedAt: z.date().nullable().optional(),
      details: z.record(z.unknown()).nullable().optional(),
    }),
    'runId',
  ).mutation(({ input }) => recordTaskInferenceUsage(input)),
  claimShowWidgetFallbackDelivery: runTokenOnlyScoped(
    z.object({
      runId: z.number(),
      toolCallId: z.string().trim().min(1).max(500),
    }),
    'runId',
  ).mutation(({ input }) => claimShowWidgetFallbackDelivery(input)),
  releaseShowWidgetFallbackDelivery: runTokenOnlyScoped(
    z.object({
      runId: z.number(),
      toolCallId: z.string().trim().min(1).max(500),
    }),
    'runId',
  ).mutation(({ input }) => releaseShowWidgetFallbackDelivery(input)),
  recordComputeProviderUsage: runScoped(
    z.object({
      runId: z.number(),
      lifecycleAction: z.enum(computeProviderUsageLifecycleActions),
      completedAt: z.date().nullable().optional(),
      activeCpuDurationMs: z.number().int().nonnegative().nullable().optional(),
      observedMemoryMibMilliseconds: z
        .number()
        .int()
        .nonnegative()
        .nullable()
        .optional(),
      networkIngressBytes: z.number().int().nonnegative().nullable().optional(),
      networkEgressBytes: z.number().int().nonnegative().nullable().optional(),
      sampledCpuUsageNsTotal: z
        .number()
        .int()
        .nonnegative()
        .nullable()
        .optional(),
      sampledMemoryUsageBytes: z
        .number()
        .int()
        .nonnegative()
        .nullable()
        .optional(),
      sampledMemoryPeakUsageBytes: z
        .number()
        .int()
        .nonnegative()
        .nullable()
        .optional(),
      details: z.record(z.unknown()).nullable().optional(),
    }),
    'runId',
  ).mutation(({ input }) => recordComputeProviderUsage(input)),
  getMessageSources: runScoped(z.object({ runId: z.number() }), 'runId').query(
    ({ input }) => getMessageSources(input.runId),
  ),
  getResolvedGitAuthor: runScoped(
    z.object({ runId: z.number() }),
    'runId',
  ).query(({ input }) => getResolvedGitAuthor(input.runId)),
  setHarnessSessionId: runScoped(
    z.object({
      runId: z.number(),
      harnessSessionId: z.string(),
    }),
    'runId',
  ).mutation(({ input }) => setTaskHarnessSessionId(input)),
  createSnapshot: runScoped(
    z.object({
      runId: z.number(),
      sandboxId: z.string(),
      snapshotIntentId: z.string().optional(),
      triggerPath: z.string().optional(),
    }),
    'runId',
  ).mutation(async ({ input }) => {
    const enqueued = await createSnapshot(input);
    return { enqueued };
  }),
  enqueueSlackPrInactivityCheck: runScoped(
    z.object({
      runId: z.number(),
      completionText: z.string().optional(),
    }),
    'runId',
  ).mutation(({ input }) => enqueueSlackPrInactivityCheck(input)),
  revertPrCommit: userOnlyProcedure
    .input(
      z.object({
        repo: z
          .string()
          .regex(/^[\w.-]+\/[\w.-]+$/, 'Invalid repository format'),
        prNumber: z.number().int().positive(),
        commitSha: z
          .string()
          .regex(
            /^[0-9a-f]{40}$/,
            'Invalid commit SHA - must be 40 characters',
          ),
      }),
    )
    .mutation(async ({ ctx, input }) => revertPrCommit(ctx.auth, input)),
  getSlackMessages: runScoped(z.object({ runId: z.number() }), 'runId').query(
    async ({ input }) => getSlackMessages(input.runId),
  ),
  getCommunicationMessages: runScoped(
    z.object({
      runId: z.number(),
      provider: communicationProviderSchema,
    }),
    'runId',
  ).query(async ({ input }) =>
    getCommunicationMessages(input.provider, input.runId),
  ),
  queueSlackMessage: runTokenOnlyScoped(
    z.object({
      runId: z.number(),
      message: z.object({
        text: z.string(),
        user: z.string(),
        userId: z.string().optional(),
        ts: z.string(),
        images: z.array(z.string()).optional(),
        formattedPrompt: z.string().optional(),
      }),
    }),
    'runId',
  ).mutation(async ({ input }) =>
    queueSlackMessage(input.runId, input.message),
  ),
  queueCommunicationMessage: runTokenOnlyScoped(
    z.object({
      runId: z.number(),
      provider: communicationProviderSchema,
      message: queuedCommunicationMessageSchema,
    }),
    'runId',
  ).mutation(async ({ input }) =>
    queueCommunicationMessage(input.provider, input.runId, input.message),
  ),
  getSlackStartedMessageData: runScoped(
    z.object({ runId: z.number() }),
    'runId',
  ).query(async ({ input }) => getSlackStartedMessageData(input.runId)),
  getSlackThreadFooterText: runScoped(
    z.object({
      runId: z.number(),
      slackChannelId: z.string(),
      threadTs: z.string(),
      taskUrl: z.string().url(),
    }),
    'runId',
  ).query(async ({ input }) => {
    const taskRun = await findTaskRun(input.runId);

    if (!taskRun) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'Task run not found',
      });
    }

    // PR linkage lives on task_pull_requests; include every active GitHub PR
    // so the existing footer can point users to the full task split.
    const linkedPrs = await db.query.taskPullRequests.findMany({
      where: and(
        eq(taskPullRequests.taskId, taskRun.taskId),
        eq(taskPullRequests.sourceControlProvider, 'github'),
        isNotNull(taskPullRequests.repository),
        isNotNull(taskPullRequests.prNumber),
      ),
      orderBy: (row, { asc }) => [asc(row.detectedAt), asc(row.createdAt)],
      columns: {
        repository: true,
        prNumber: true,
        prUrl: true,
        status: true,
      },
    });

    const activeLinkedPrs = linkedPrs.filter(
      (pr) => pr.status !== 'closed' && pr.status !== 'merged',
    );

    return buildSlackThreadFooterText({
      taskUrl: input.taskUrl,
      taskId: taskRun.taskId,
      prRepo: activeLinkedPrs[0]?.repository ?? null,
      prNumber: activeLinkedPrs[0]?.prNumber ?? null,
      linkedPrs: activeLinkedPrs.flatMap((pr) =>
        pr.prNumber !== null && pr.prUrl
          ? [{ prNumber: pr.prNumber, prUrl: pr.prUrl }]
          : [],
      ),
      channelId: input.slackChannelId,
      threadTs: input.threadTs,
    });
  }),
  recordOutboundSlackConversationMessage: runScoped(
    z.object({
      runId: z.number(),
      slackChannelId: z.string(),
      conversationKind: z.enum(['dm', 'thread']),
      threadTs: z.string().optional(),
      messageTs: z.string(),
      source: z.string(),
      text: z.string().optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
    }),
    'runId',
  ).mutation(async ({ input }) => {
    const taskRun = await findTaskRun(input.runId);

    if (!taskRun?.actingUserId) {
      return;
    }

    const slackInstallation = await db.query.slackInstallations.findFirst({
      where: eq(slackInstallations.isActive, true),
      columns: {
        teamId: true,
      },
    });

    if (!slackInstallation?.teamId) {
      return;
    }

    const subject = await findSlackConversationSubjectByUserId({
      userId: taskRun.actingUserId,
      slackTeamId: slackInstallation.teamId,
    });

    if (!subject) {
      return;
    }

    await recordSlackConversationMessageBestEffort({
      logContext: 'sdk.taskRuns.recordOutboundSlackConversationMessage',
      ...subject,
      slackChannelId: input.slackChannelId,
      conversationKind: input.conversationKind,
      threadTs: input.threadTs ?? null,
      messageTs: input.messageTs,
      direction: 'outbound',
      authorKind: 'roomote',
      source: input.source,
      text: input.text,
      taskId: taskRun.taskId,
      runId: taskRun.id,
      metadata: input.metadata,
    });
  }),
  setPendingSlackRequestUserInput: runScoped(
    z.object({
      runId: z.number(),
      threadId: z.string(),
      requestId: z.string(),
      taskId: z.string(),
      questions: z.array(acpRequestUserInputQuestionSchema),
      promptMessageTs: z.string().optional(),
    }),
    'runId',
  ).mutation(async ({ input }) =>
    setPendingSlackRequestUserInput(input.threadId, {
      requestId: input.requestId,
      runId: input.runId,
      taskId: input.taskId,
      questions: input.questions,
      promptMessageTs: input.promptMessageTs,
    }),
  ),
  clearPendingSlackRequestUserInput: runScoped(
    z.object({
      runId: z.number(),
      threadId: z.string(),
      requestId: z.string().optional(),
    }),
    'runId',
  ).mutation(async ({ input }) =>
    clearPendingSlackRequestUserInput(
      input.threadId,
      input.requestId ? { requestId: input.requestId } : undefined,
    ),
  ),
  getSlackRequestUserInputAnswers: runScoped(
    z.object({ runId: z.number() }),
    'runId',
  ).query(async ({ input }) => getSlackRequestUserInputAnswers(input.runId)),
  queueSlackRequestUserInputAnswer: runScoped(
    z.object({
      runId: z.number(),
      requestId: z.string(),
      answers: acpRequestUserInputAnswersSchema,
      user: z.string(),
      userId: z.string().optional(),
      ts: z.string(),
    }),
    'runId',
  ).mutation(async ({ input }) =>
    queueSlackRequestUserInputAnswer(input.runId, {
      requestId: input.requestId,
      answers: input.answers,
      user: input.user,
      userId: input.userId,
      ts: input.ts,
    }),
  ),
  getLinearMessages: runScoped(z.object({ runId: z.number() }), 'runId').query(
    async ({ input }) => getLinearMessages(input.runId),
  ),
  queueLinearMessage: runTokenOnlyScoped(
    z.object({
      runId: z.number(),
      sessionId: z.string(),
      payload: agentSessionEventPayloadSchema,
      userId: z.string().optional(),
    }),
    'runId',
  ).mutation(async ({ input }) =>
    queueLinearMessage(
      input.runId,
      input.sessionId,
      input.payload,
      input.userId,
    ),
  ),
  setPendingLinearRequestUserInput: runScoped(
    z.object({
      runId: z.number(),
      sessionId: z.string(),
      requestId: z.string(),
      taskId: z.string(),
      questions: z.array(acpRequestUserInputQuestionSchema),
    }),
    'runId',
  ).mutation(async ({ input }) =>
    setPendingLinearRequestUserInput(input.sessionId, {
      requestId: input.requestId,
      runId: input.runId,
      taskId: input.taskId,
      sessionId: input.sessionId,
      questions: input.questions,
    }),
  ),
  clearPendingLinearRequestUserInput: runScoped(
    z.object({
      runId: z.number(),
      sessionId: z.string(),
      requestId: z.string().optional(),
    }),
    'runId',
  ).mutation(async ({ input }) =>
    clearPendingLinearRequestUserInput(
      input.sessionId,
      input.requestId ? { requestId: input.requestId } : undefined,
    ),
  ),
  getLinearRequestUserInputAnswers: runScoped(
    z.object({ runId: z.number() }),
    'runId',
  ).query(async ({ input }) => getLinearRequestUserInputAnswers(input.runId)),
  queueLinearRequestUserInputAnswer: runScoped(
    z.object({
      runId: z.number(),
      requestId: z.string(),
      answers: acpRequestUserInputAnswersSchema,
      userId: z.string().optional(),
      timestamp: z.number(),
    }),
    'runId',
  ).mutation(async ({ input }) =>
    queueLinearRequestUserInputAnswer(input.runId, {
      requestId: input.requestId,
      answers: input.answers,
      userId: input.userId,
      timestamp: input.timestamp,
    }),
  ),
  publishDiscordRequestUserInput: runScoped(
    z.object({
      runId: z.number(),
      requestId: z.string(),
      taskId: z.string(),
      questions: z.array(acpRequestUserInputQuestionSchema),
    }),
    'runId',
  ).mutation(async ({ input }) => {
    const taskRun = await findTaskRun(input.runId);
    if (!taskRun) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: `Task run ${input.runId} not found`,
      });
    }

    const provider =
      getCommunicationProviderFromTaskPayload(taskRun.payload) ?? 'discord';
    if (
      provider !== 'discord' &&
      provider !== 'telegram' &&
      provider !== 'teams'
    ) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: `request_user_input publish is not supported for provider ${provider}`,
      });
    }

    const channelId = getCommunicationChannelFromTaskPayload(taskRun.payload);
    const threadId = getCommunicationThreadIdFromTaskPayload(taskRun.payload);
    const conversationId = getCommunicationRequestUserInputConversationId({
      channelId,
      threadId,
    });
    const existing = conversationId
      ? await getPendingCommunicationRequestUserInput(provider, conversationId)
      : null;
    // Reuse any pending prompt for this run so mid-flight question enrichment
    // edits one message instead of posting a second shell.
    const existingForRequest =
      existing &&
      existing.runId === input.runId &&
      existing.status === 'pending'
        ? existing
        : null;

    return publishCommunicationRequestUserInput({
      runId: input.runId,
      taskId: input.taskId,
      payload: taskRun.payload,
      request: {
        requestId: input.requestId,
        questions: input.questions,
      },
      existing: existingForRequest,
    });
  }),
  publishCommunicationRequestUserInput: runScoped(
    z.object({
      runId: z.number(),
      requestId: z.string(),
      taskId: z.string(),
      questions: z.array(acpRequestUserInputQuestionSchema),
    }),
    'runId',
  ).mutation(async ({ input }) => {
    // Alias: same implementation resolve provider from the task payload.
    const taskRun = await findTaskRun(input.runId);
    if (!taskRun) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: `Task run ${input.runId} not found`,
      });
    }

    const provider =
      getCommunicationProviderFromTaskPayload(taskRun.payload) ?? 'discord';
    if (
      provider !== 'discord' &&
      provider !== 'telegram' &&
      provider !== 'teams'
    ) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: `request_user_input publish is not supported for provider ${provider}`,
      });
    }

    const channelId = getCommunicationChannelFromTaskPayload(taskRun.payload);
    const threadId = getCommunicationThreadIdFromTaskPayload(taskRun.payload);
    const conversationId = getCommunicationRequestUserInputConversationId({
      channelId,
      threadId,
    });
    const existing = conversationId
      ? await getPendingCommunicationRequestUserInput(provider, conversationId)
      : null;
    const existingForRequest =
      existing &&
      existing.runId === input.runId &&
      existing.status === 'pending'
        ? existing
        : null;

    return publishCommunicationRequestUserInput({
      runId: input.runId,
      taskId: input.taskId,
      payload: taskRun.payload,
      request: {
        requestId: input.requestId,
        questions: input.questions,
      },
      existing: existingForRequest,
    });
  }),
  setPendingCommunicationRequestUserInput: runScoped(
    z.object({
      runId: z.number(),
      provider: communicationProviderSchema,
      conversationId: z.string(),
      requestId: z.string(),
      taskId: z.string(),
      questions: z.array(acpRequestUserInputQuestionSchema),
      promptMessageId: z.string().optional(),
      currentQuestionIndex: z.number().optional(),
    }),
    'runId',
  ).mutation(async ({ input }) =>
    setPendingCommunicationRequestUserInput(
      input.provider,
      input.conversationId,
      {
        requestId: input.requestId,
        runId: input.runId,
        taskId: input.taskId,
        questions: input.questions,
        promptMessageId: input.promptMessageId,
        currentQuestionIndex: input.currentQuestionIndex,
      },
    ),
  ),
  clearPendingCommunicationRequestUserInput: runScoped(
    z.object({
      runId: z.number(),
      provider: communicationProviderSchema,
      conversationId: z.string(),
      requestId: z.string().optional(),
    }),
    'runId',
  ).mutation(async ({ input }) =>
    clearPendingCommunicationRequestUserInput(
      input.provider,
      input.conversationId,
      input.requestId ? { requestId: input.requestId } : undefined,
    ),
  ),
  /**
   * Worker onStart hook: drop the Discord intake 👀 reaction once the runtime
   * is live (Slack parity). Soft/no-op for non-Discord runs.
   */
  clearCommunicationAckReaction: runScoped(
    z.object({
      runId: z.number(),
    }),
    'runId',
  ).mutation(async ({ input }) => clearCommunicationAckReaction(input)),
  getCommunicationRequestUserInputAnswers: runScoped(
    z.object({
      runId: z.number(),
      provider: communicationProviderSchema,
    }),
    'runId',
  ).query(async ({ input }) =>
    getCommunicationRequestUserInputAnswers(input.provider, input.runId),
  ),
  queueCommunicationRequestUserInputAnswer: runScoped(
    z.object({
      runId: z.number(),
      provider: communicationProviderSchema,
      requestId: z.string(),
      answers: acpRequestUserInputAnswersSchema,
      userId: z.string().optional(),
      timestamp: z.number(),
    }),
    'runId',
  ).mutation(async ({ input }) =>
    queueCommunicationRequestUserInputAnswer(input.provider, input.runId, {
      requestId: input.requestId,
      answers: input.answers,
      userId: input.userId,
      timestamp: input.timestamp,
    }),
  ),
  fetchSnapshotEnv: runScoped(z.object({ runId: z.number() }), 'runId').query(
    ({ ctx, input }) => fetchSnapshotEnv(ctx.auth, input),
  ),
  getResolvedRuntimeEnvVars: runScoped(
    z.object({ runId: z.number() }),
    'runId',
  ).query(({ ctx, input }) => getResolvedRuntimeEnvVars(ctx.auth, input)),

  refreshGitHubTokenWithMetadata: runScoped(
    z.object({ runId: z.number() }),
    'runId',
  ).mutation(({ ctx, input }) =>
    refreshGitHubTokenWithMetadata(ctx.auth, input.runId),
  ),
});
