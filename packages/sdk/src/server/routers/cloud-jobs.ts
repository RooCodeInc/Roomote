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
  computeProviderLaunchModes,
  computeProviderUsageLifecycleActions,
  doneRunStatuses,
  queuedCommunicationMessageSchema,
  snapshotResumeSchema,
  sourceControlProviderSchema,
  ROOMOTE_RUNTIME_TASK_MESSAGE_PROTOCOL,
  type AcpPersistedEnvelope,
} from '@roomote/types';
import {
  getCommunicationMessages,
  queueCommunicationMessage,
} from '@roomote/communication/messages';
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

import {
  authenticatedProcedure,
  isJobToken,
  jobScoped,
  nonJobProcedure,
  router,
} from '../trpc';

import {
  findCloudJob,
  findCloudJobRuntimeState,
  updateCloudJob,
  updateCloudJobRuntimeState,
  touchCloudJobHeartbeat,
  dequeueCloudJob,
  dequeueResumeCloudJob,
  finishRun,
  revertPrCommit,
  createSnapshot,
  refreshGitHubTokenWithMetadata,
  fetchSnapshotEnv,
  recordCloudJobEvent,
  stampCloudJobMilestone,
  cloudJobMilestoneFields,
  recordTaskMessageEnvelope,
  recordTaskInferenceUsage,
  recordComputeProviderUsage,
  getMessageSources,
  setTaskHarnessSessionId,
  enqueueSlackPrInactivityCheck,
  getResolvedRuntimeEnvVars,
  getResolvedGitAuthor,
  findCloudJobByJobTokenClaims,
} from '../lib/cloud-jobs';
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

function jobTokenOnlyScoped<T extends z.ZodType>(
  schema: T,
  extractJobId: keyof z.infer<T> | ((input: z.infer<T>) => number),
) {
  return authenticatedProcedure
    .input(schema)
    .use(async ({ ctx, input, next }) => {
      if (!isJobToken(ctx.auth)) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'This endpoint is only available to job tokens',
        });
      }

      const targetId =
        typeof extractJobId === 'function'
          ? extractJobId(input)
          : (input as Record<string, unknown>)[extractJobId as string];

      if (targetId !== ctx.auth.cloudJobId) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Cannot access resources from a different job',
        });
      }

      const scopedJob = await findCloudJobByJobTokenClaims(ctx.auth);

      if (!scopedJob) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Cannot access resources from a different job',
        });
      }

      return next({ ctx: { ...ctx, cloudJobId: ctx.auth.cloudJobId } });
    });
}

export const cloudJobsRouter = router({
  findFirstById: jobScoped(z.number(), (id) => id).query(({ input }) =>
    findCloudJob(input),
  ),
  // Narrow snapshot for worker polling loops; avoids fetching large columns
  // (payload, prompt, result) every few seconds per active sandbox.
  findRuntimeStateById: jobScoped(z.number(), (id) => id).query(({ input }) =>
    findCloudJobRuntimeState(input),
  ),
  update: jobScoped(
    z.object({
      id: z.number(),
      status: z.nativeEnum(RunStatus).optional(),
      taskPhase: z.string().nullish(),
      sleepAt: z.date().nullish(),
      // `taskId` is intentionally NOT writable here. This mutation is
      // reachable with a run-scoped job token (held by the sandbox runtime),
      // and a run's task binding is what attribution, visibility, and PR
      // linkage hang off of. Letting the sandbox re-point its run at a
      // different task would corrupt run->task integrity; runs are bound to a
      // task at enqueue time and never re-parented. No worker code path sends
      // this field.
      actingUserId: z.string().optional(),
      result: z.record(z.unknown()).optional(),
    }),
    'id',
  ).mutation(({ input: { id, ...values } }) => updateCloudJob(id, values)),
  updateRuntimeState: jobScoped(
    z.object({
      id: z.number(),
      taskPhase: z.string().nullish(),
      sleepAt: z.date().nullish(),
    }),
    'id',
  ).mutation(({ input: { id, taskPhase, sleepAt } }) =>
    updateCloudJobRuntimeState(id, {
      taskPhase: taskPhase ?? null,
      sleepAt: sleepAt ?? null,
    }),
  ),
  touchCloudJobHeartbeat: jobScoped(
    z.object({
      id: z.number(),
      heartbeatAt: z.date().nullish(),
    }),
    'id',
  ).mutation(({ input: { id, heartbeatAt } }) =>
    touchCloudJobHeartbeat(id, heartbeatAt ?? new Date()),
  ),
  stampMilestone: jobScoped(
    z.object({
      cloudJobId: z.number(),
      field: z.enum(cloudJobMilestoneFields),
      at: z.date().nullish(),
      launchMode: z.enum(computeProviderLaunchModes).optional(),
    }),
    'cloudJobId',
  ).mutation(({ input: { cloudJobId, field, at, launchMode } }) =>
    stampCloudJobMilestone({
      cloudJobId,
      field,
      at: at ?? undefined,
      launchMode,
    }),
  ),
  enqueue: nonJobProcedure
    .input(enqueueTaskInputSchema)
    .mutation(async ({ input }) => {
      const launchResult = await enqueueTask(input as EnqueueTaskInput);

      return {
        id: launchResult.id,
        taskId: launchResult.taskId,
      };
    }),
  dequeue: jobScoped(
    z.object({ cloudJobId: z.number() }).merge(workerReleaseMetadataSchema),
    'cloudJobId',
  ).mutation(({ ctx, input }) => dequeueCloudJob(ctx.auth, input)),
  resume: jobScoped(
    z.object({ cloudJobId: z.number() }).merge(workerReleaseMetadataSchema),
    'cloudJobId',
  ).mutation(({ ctx, input }) => dequeueResumeCloudJob(ctx.auth, input)),
  done: jobScoped(
    z.object({
      id: z.number(),
      status: z.enum(doneRunStatuses),
      error: z.string().optional(),
    }),
    'id',
  ).mutation(({ input }) => finishRun(input)),
  recordEvent: jobScoped(
    z.object({
      cloudJobId: z.number(),
      source: z.enum(runEventSources),
      eventType: z.enum(runEventTypes),
      message: z.string().optional(),
      details: z.record(z.unknown()).optional(),
    }),
    'cloudJobId',
  ).mutation(({ input }) => recordCloudJobEvent(input)),
  recordMessageEnvelope: jobTokenOnlyScoped(
    z.object({
      cloudJobId: z.number(),
      taskId: z.string(),
      envelope: runtimePersistedEnvelopeSchema,
    }),
    'cloudJobId',
  ).mutation(({ ctx, input }) => {
    // Deployment-principal job tokens carry no human user; leave the
    // attribution unset so the envelope persists without a user id.
    const userId =
      'userId' in ctx.auth ? (ctx.auth.userId ?? undefined) : undefined;

    return recordTaskMessageEnvelope({
      cloudJobId: input.cloudJobId,
      taskId: input.taskId,
      userId,
      envelope: input.envelope,
    });
  }),
  recordInferenceUsage: jobTokenOnlyScoped(
    z.object({
      cloudJobId: z.number(),
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
      costSource: z.enum(['opencode_message', 'missing']).nullable().optional(),
      messageCreatedAt: z.date().nullable().optional(),
      messageCompletedAt: z.date().nullable().optional(),
      details: z.record(z.unknown()).nullable().optional(),
    }),
    'cloudJobId',
  ).mutation(({ input }) => recordTaskInferenceUsage(input)),
  recordComputeProviderUsage: jobScoped(
    z.object({
      cloudJobId: z.number(),
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
    'cloudJobId',
  ).mutation(({ input }) => recordComputeProviderUsage(input)),
  getMessageSources: jobScoped(
    z.object({ cloudJobId: z.number() }),
    'cloudJobId',
  ).query(({ input }) => getMessageSources(input.cloudJobId)),
  getResolvedGitAuthor: jobScoped(
    z.object({ cloudJobId: z.number() }),
    'cloudJobId',
  ).query(({ input }) => getResolvedGitAuthor(input.cloudJobId)),
  setHarnessSessionId: jobScoped(
    z.object({
      cloudJobId: z.number(),
      harnessSessionId: z.string(),
    }),
    'cloudJobId',
  ).mutation(({ input }) => setTaskHarnessSessionId(input)),
  createSnapshot: jobScoped(
    z.object({
      cloudJobId: z.number(),
      sandboxId: z.string(),
      snapshotIntentId: z.string().optional(),
      triggerPath: z.string().optional(),
    }),
    'cloudJobId',
  ).mutation(async ({ input }) => {
    const enqueued = await createSnapshot(input);
    return { enqueued };
  }),
  enqueueSlackPrInactivityCheck: jobScoped(
    z.object({
      cloudJobId: z.number(),
      completionText: z.string().optional(),
    }),
    'cloudJobId',
  ).mutation(({ input }) => enqueueSlackPrInactivityCheck(input)),
  revertPrCommit: nonJobProcedure
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
  getSlackMessages: jobScoped(
    z.object({ cloudJobId: z.number() }),
    'cloudJobId',
  ).query(async ({ input }) => getSlackMessages(input.cloudJobId)),
  getCommunicationMessages: jobScoped(
    z.object({
      cloudJobId: z.number(),
      provider: communicationProviderSchema,
    }),
    'cloudJobId',
  ).query(async ({ input }) =>
    getCommunicationMessages(input.provider, input.cloudJobId),
  ),
  queueSlackMessage: jobTokenOnlyScoped(
    z.object({
      cloudJobId: z.number(),
      message: z.object({
        text: z.string(),
        user: z.string(),
        userId: z.string().optional(),
        ts: z.string(),
        images: z.array(z.string()).optional(),
        formattedPrompt: z.string().optional(),
      }),
    }),
    'cloudJobId',
  ).mutation(async ({ input }) =>
    queueSlackMessage(input.cloudJobId, input.message),
  ),
  queueCommunicationMessage: jobTokenOnlyScoped(
    z.object({
      cloudJobId: z.number(),
      provider: communicationProviderSchema,
      message: queuedCommunicationMessageSchema,
    }),
    'cloudJobId',
  ).mutation(async ({ input }) =>
    queueCommunicationMessage(input.provider, input.cloudJobId, input.message),
  ),
  getSlackStartedMessageData: jobScoped(
    z.object({ cloudJobId: z.number() }),
    'cloudJobId',
  ).query(async ({ input }) => getSlackStartedMessageData(input.cloudJobId)),
  getSlackThreadFooterText: jobScoped(
    z.object({
      cloudJobId: z.number(),
      slackChannelId: z.string(),
      threadTs: z.string(),
      taskUrl: z.string().url(),
    }),
    'cloudJobId',
  ).query(async ({ input }) => {
    const cloudJob = await findCloudJob(input.cloudJobId);

    if (!cloudJob) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'Cloud job not found',
      });
    }

    // PR linkage lives on task_pull_requests; use the task's primary
    // (earliest-detected) GitHub PR for the footer link.
    const linkedPr = await db.query.taskPullRequests.findFirst({
      where: and(
        eq(taskPullRequests.taskId, cloudJob.taskId),
        eq(taskPullRequests.sourceControlProvider, 'github'),
        isNotNull(taskPullRequests.repository),
        isNotNull(taskPullRequests.prNumber),
      ),
      orderBy: (row, { asc }) => [asc(row.detectedAt), asc(row.createdAt)],
      columns: {
        repository: true,
        prNumber: true,
      },
    });

    return buildSlackThreadFooterText({
      taskUrl: input.taskUrl,
      taskId: cloudJob.taskId,
      prRepo: linkedPr?.repository ?? null,
      prNumber: linkedPr?.prNumber ?? null,
      channelId: input.slackChannelId,
      threadTs: input.threadTs,
    });
  }),
  recordOutboundSlackConversationMessage: jobScoped(
    z.object({
      cloudJobId: z.number(),
      slackChannelId: z.string(),
      conversationKind: z.enum(['dm', 'thread']),
      threadTs: z.string().optional(),
      messageTs: z.string(),
      source: z.string(),
      text: z.string().optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
    }),
    'cloudJobId',
  ).mutation(async ({ input }) => {
    const cloudJob = await findCloudJob(input.cloudJobId);

    if (!cloudJob?.actingUserId) {
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
      userId: cloudJob.actingUserId,
      slackTeamId: slackInstallation.teamId,
    });

    if (!subject) {
      return;
    }

    await recordSlackConversationMessageBestEffort({
      logContext: 'sdk.cloudJobs.recordOutboundSlackConversationMessage',
      ...subject,
      slackChannelId: input.slackChannelId,
      conversationKind: input.conversationKind,
      threadTs: input.threadTs ?? null,
      messageTs: input.messageTs,
      direction: 'outbound',
      authorKind: 'roomote',
      source: input.source,
      text: input.text,
      taskId: cloudJob.taskId,
      cloudJobId: cloudJob.id,
      metadata: input.metadata,
    });
  }),
  setPendingSlackRequestUserInput: jobScoped(
    z.object({
      cloudJobId: z.number(),
      threadId: z.string(),
      requestId: z.string(),
      taskId: z.string(),
      questions: z.array(acpRequestUserInputQuestionSchema),
      promptMessageTs: z.string().optional(),
    }),
    'cloudJobId',
  ).mutation(async ({ input }) =>
    setPendingSlackRequestUserInput(input.threadId, {
      requestId: input.requestId,
      cloudJobId: input.cloudJobId,
      taskId: input.taskId,
      questions: input.questions,
      promptMessageTs: input.promptMessageTs,
    }),
  ),
  clearPendingSlackRequestUserInput: jobScoped(
    z.object({
      cloudJobId: z.number(),
      threadId: z.string(),
      requestId: z.string().optional(),
    }),
    'cloudJobId',
  ).mutation(async ({ input }) =>
    clearPendingSlackRequestUserInput(
      input.threadId,
      input.requestId ? { requestId: input.requestId } : undefined,
    ),
  ),
  getSlackRequestUserInputAnswers: jobScoped(
    z.object({ cloudJobId: z.number() }),
    'cloudJobId',
  ).query(async ({ input }) =>
    getSlackRequestUserInputAnswers(input.cloudJobId),
  ),
  queueSlackRequestUserInputAnswer: jobScoped(
    z.object({
      cloudJobId: z.number(),
      requestId: z.string(),
      answers: acpRequestUserInputAnswersSchema,
      user: z.string(),
      userId: z.string().optional(),
      ts: z.string(),
    }),
    'cloudJobId',
  ).mutation(async ({ input }) =>
    queueSlackRequestUserInputAnswer(input.cloudJobId, {
      requestId: input.requestId,
      answers: input.answers,
      user: input.user,
      userId: input.userId,
      ts: input.ts,
    }),
  ),
  getLinearMessages: jobScoped(
    z.object({ cloudJobId: z.number() }),
    'cloudJobId',
  ).query(async ({ input }) => getLinearMessages(input.cloudJobId)),
  queueLinearMessage: jobTokenOnlyScoped(
    z.object({
      cloudJobId: z.number(),
      sessionId: z.string(),
      payload: agentSessionEventPayloadSchema,
      userId: z.string().optional(),
    }),
    'cloudJobId',
  ).mutation(async ({ input }) =>
    queueLinearMessage(
      input.cloudJobId,
      input.sessionId,
      input.payload,
      input.userId,
    ),
  ),
  setPendingLinearRequestUserInput: jobScoped(
    z.object({
      cloudJobId: z.number(),
      sessionId: z.string(),
      requestId: z.string(),
      taskId: z.string(),
      questions: z.array(acpRequestUserInputQuestionSchema),
    }),
    'cloudJobId',
  ).mutation(async ({ input }) =>
    setPendingLinearRequestUserInput(input.sessionId, {
      requestId: input.requestId,
      cloudJobId: input.cloudJobId,
      taskId: input.taskId,
      sessionId: input.sessionId,
      questions: input.questions,
    }),
  ),
  clearPendingLinearRequestUserInput: jobScoped(
    z.object({
      cloudJobId: z.number(),
      sessionId: z.string(),
      requestId: z.string().optional(),
    }),
    'cloudJobId',
  ).mutation(async ({ input }) =>
    clearPendingLinearRequestUserInput(
      input.sessionId,
      input.requestId ? { requestId: input.requestId } : undefined,
    ),
  ),
  getLinearRequestUserInputAnswers: jobScoped(
    z.object({ cloudJobId: z.number() }),
    'cloudJobId',
  ).query(async ({ input }) =>
    getLinearRequestUserInputAnswers(input.cloudJobId),
  ),
  queueLinearRequestUserInputAnswer: jobScoped(
    z.object({
      cloudJobId: z.number(),
      requestId: z.string(),
      answers: acpRequestUserInputAnswersSchema,
      userId: z.string().optional(),
      timestamp: z.number(),
    }),
    'cloudJobId',
  ).mutation(async ({ input }) =>
    queueLinearRequestUserInputAnswer(input.cloudJobId, {
      requestId: input.requestId,
      answers: input.answers,
      userId: input.userId,
      timestamp: input.timestamp,
    }),
  ),
  fetchSnapshotEnv: jobScoped(
    z.object({ cloudJobId: z.number() }),
    'cloudJobId',
  ).query(({ ctx, input }) => fetchSnapshotEnv(ctx.auth, input)),
  getResolvedRuntimeEnvVars: jobScoped(
    z.object({ cloudJobId: z.number() }),
    'cloudJobId',
  ).query(({ ctx, input }) => getResolvedRuntimeEnvVars(ctx.auth, input)),

  refreshGitHubTokenWithMetadata: jobScoped(
    z.object({ cloudJobId: z.number() }),
    'cloudJobId',
  ).mutation(({ ctx, input }) =>
    refreshGitHubTokenWithMetadata(ctx.auth, input.cloudJobId),
  ),
});
