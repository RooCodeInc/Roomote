import {
  TaskModelSelectionError,
  applyTaskModelSelectionToRun,
  canRetryFailedStart,
} from '@roomote/cloud-agents/server';
import {
  REASONING_EFFORT_VALUES,
  RunStatus,
  TaskPayloadKind,
  activeRunStatuses,
  getCommunicationChannelFromTaskPayload,
  getCommunicationProviderFromTaskPayload,
  getEnvironmentDefinitionIdFromPayload,
  isBootingRunStatus,
  isExitedRunStatus,
  resolveSourceControlProviderFromPayload,
  taskToolDispatchPayloadSchema,
  type TaskGoal,
} from '@roomote/types';
import { createRunToken } from '@roomote/auth';
import {
  clearLatestUserMessageForReplyQuoteIfId,
  setLatestUserMessageForReplyQuote,
  trackLatestUserMessageForReplyQuote,
} from '@roomote/communication/messages';
import {
  and,
  compareAndSetTrustedRunActingUser,
  db,
  environments,
  eq,
  inArray,
  isNotNull,
  getTaskGoalForRun,
  not,
  resolveEffectivePreviewRuntimeConfig,
  taskMessages,
  taskRuns,
  tasks,
} from '@roomote/db/server';
import { httpBatchLink, TRPCClientError } from '@trpc/client';
import { TRPCError } from '@trpc/server';
import { createSandboxServerRpcClient } from '@roomote/sdk/sandbox-router';
import superjson from 'superjson';
import { z } from 'zod';

import type { UserAuthSuccess } from '@/types';
import { Env } from '@/lib/server';

import { type TaskRunDetail, findActiveSuccessorTaskRun } from '@/lib/server';
import { getTaskRunVisiblePrompt } from '@/lib';
import {
  claimOutOfBandContextForPrompt,
  releaseOutOfBandContext,
  withOutOfBandContext,
} from '@/lib/server/out-of-band-context';
import { getUserDisplayName } from '@/lib/user-display-name';

import { restoreSnapshotResumeVisiblePromptFields } from '../snapshot-visible-prompt';
import {
  resolveTaskByIdAccessCommand,
  type TaskByIdAccessResult,
} from '../tasks/by-id';

import {
  getSessionState,
  shouldExposeOnboardingEnvironment,
  shouldPollForFirstHarnessMessage,
} from './session-state';

const SANDBOX_PROMPT_TOKEN_TIMEOUT_MS = 15 * 60 * 1000;
const SANDBOX_PROMPT_TIMEOUT_MS = 30_000;
const SANDBOX_RPC_HEALTHCHECK_TIMEOUT_MS = 5_000;
const requestUserInputAnswersSchema = z.record(
  z.object({
    answers: z.array(z.string()),
  }),
);

function getAuthenticatedPromptUserName(
  auth: Pick<UserAuthSuccess, 'name' | 'primaryEmail'>,
): string | undefined {
  return (
    getUserDisplayName({
      name: auth.name,
      email: auth.primaryEmail,
    }) ?? undefined
  );
}

async function assertSandboxRpcEndpointReachable(sandboxServerUrl: string) {
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    SANDBOX_RPC_HEALTHCHECK_TIMEOUT_MS,
  );

  try {
    const response = await fetch(`${sandboxServerUrl}/trpc`, {
      signal: controller.signal,
    });
    const contentType = response.headers.get('content-type') ?? '';

    if (!contentType.includes('application/json')) {
      throw new Error(
        `Sandbox RPC endpoint returned ${contentType || 'unknown content type'}`,
      );
    }
  } catch (error) {
    throw new TRPCError({
      code: 'CONFLICT',
      message:
        'The task is no longer connected to a live sandbox. Refresh the page or start a new task.',
      cause: error,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

export const sendSandboxPromptInputSchema = z
  .object({
    taskId: z.string(),
    prompt: z.string().optional(),
    taskTool: taskToolDispatchPayloadSchema.optional(),
    images: z.array(z.string()).optional(),
    source: z.string().optional(),
    clientMessageId: z.string().optional(),
    userImageUrl: z.string().optional(),
    autoSteerWhenQueued: z.boolean().optional(),
  })
  .superRefine((data, ctx) => {
    const hasPrompt =
      typeof data.prompt === 'string' && data.prompt.trim().length > 0;
    const hasImages = (data.images?.length ?? 0) > 0;

    if (data.taskTool && (data.prompt !== undefined || hasImages)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Task Tool dispatch must use only the structured taskTool payload',
        path: ['taskTool'],
      });
    }

    if (!data.taskTool && !hasPrompt && !hasImages) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Either prompt text, a Task Tool action, or images must be provided',
        path: ['prompt'],
      });
    }
  });

export const answerSandboxUserInputRequestInputSchema = z.object({
  taskId: z.string(),
  requestId: z.string().min(1),
  answers: requestUserInputAnswersSchema,
});

/**
 * Trusted actor switch, applied BEFORE the prompt reaches the sandbox.
 *
 * The worker refuses to run a turn whose sender does not match the
 * server-side `task_runs.actingUserId` (see prepareActorScopedTurn), so runs
 * that start without an acting user — e.g. automation-started tasks — would
 * otherwise reject every web prompt with an actor-scoped credentials error.
 * Mirrors `syncActingUserIdBeforeDelivery` in the API's sendMessageToTask:
 * the write must land before delivery so credential resolution and turn
 * attribution agree, and a failed delivery rolls the actor back via
 * {@link restoreActingUserIdAfterFailedSandboxDelivery}.
 */
async function syncActingUserIdBeforeSandboxDelivery({
  runId,
  currentActingUserId,
  nextActingUserId,
}: {
  runId: number;
  currentActingUserId: string | null;
  nextActingUserId: string;
}): Promise<boolean> {
  if (currentActingUserId === nextActingUserId) {
    return false;
  }

  return await compareAndSetTrustedRunActingUser({
    runId,
    expectedUserId: currentActingUserId,
    nextUserId: nextActingUserId,
  });
}

/**
 * Best-effort compare-and-set rollback for a trusted actor switch whose
 * sandbox delivery failed. The CAS avoids overwriting a newer sender that
 * won the race after this request changed the actor.
 */
async function restoreActingUserIdAfterFailedSandboxDelivery({
  runId,
  previousActingUserId,
  attemptedActingUserId,
}: {
  runId: number;
  previousActingUserId: string | null;
  attemptedActingUserId: string;
}): Promise<void> {
  try {
    await compareAndSetTrustedRunActingUser({
      runId,
      expectedUserId: attemptedActingUserId,
      nextUserId: previousActingUserId,
    });
  } catch (error) {
    console.error(
      `Failed to roll back actingUserId after sandbox delivery failed for run ${runId} ` +
        `(attempted=${attemptedActingUserId}, previous=${previousActingUserId ?? 'null'}):`,
      error,
    );
  }
}

/**
 * Persists the user's in-progress prompt text so it survives sleep/wake cycles.
 * Also acts as an implicit keepalive signal (the caller should throttle on the
 * client side — ~10 s is a reasonable interval).
 */
export async function saveDraftPromptCommand(
  auth: UserAuthSuccess,
  input: { runId: number; draftPrompt: string },
) {
  // Draft prompts live on the task now (they survive run/resume boundaries);
  // the input stays run-scoped so the tRPC procedure contract is unchanged.
  const run = await db.query.taskRuns.findFirst({
    where: eq(taskRuns.id, input.runId),
    columns: { taskId: true },
  });

  if (run) {
    await db
      .update(tasks)
      .set({ draftPrompt: input.draftPrompt || null })
      .where(eq(tasks.id, run.taskId));
  }

  return { success: true };
}

export async function sendSandboxPromptCommand(
  auth: UserAuthSuccess,
  input: z.input<typeof sendSandboxPromptInputSchema>,
  trustedContext?: { goalContext?: TaskGoal },
) {
  const parsed = sendSandboxPromptInputSchema.parse(input);
  const { taskRun } = await getResolvedSandboxTaskRunByTaskId(auth, {
    taskId: parsed.taskId,
  });
  const currentGoal = trustedContext?.goalContext
    ? null
    : await getTaskGoalForRun(taskRun.id);
  const goalContext =
    trustedContext?.goalContext ??
    (currentGoal?.status === 'active' ? currentGoal : undefined);

  if (!taskRun.sandboxServerUrl) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: "The task hasn't started yet. Try again in a few seconds.",
    });
  }

  await assertSandboxRpcEndpointReachable(taskRun.sandboxServerUrl);

  const authToken = await createRunToken({
    runId: taskRun.id,
    userId: auth.userId,
    timeoutMs: SANDBOX_PROMPT_TOKEN_TIMEOUT_MS,
  });

  // Re-surface messages posted to the task while the session was idle (e.g.
  // PR review-feedback notifications) — they are in the transcript but not in
  // the harness session, so the agent would otherwise have no idea what the
  // user's reply refers to. Claimed after the reachability checks so every
  // failure path below releases the claim via the catch block.
  const outOfBandContext =
    typeof parsed.prompt === 'string' && parsed.prompt.trim().length > 0
      ? await claimOutOfBandContextForPrompt(parsed.taskId)
      : null;

  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    SANDBOX_PROMPT_TIMEOUT_MS,
  );

  const previousActingUserId = taskRun.actingUserId;
  const requiresActorHandoff = previousActingUserId !== auth.userId;
  const promptUserName = getAuthenticatedPromptUserName(auth);
  const shouldTrackDiscordReplyQuote =
    parsed.source === 'web' &&
    typeof parsed.prompt === 'string' &&
    parsed.prompt.trim().length > 0 &&
    getCommunicationProviderFromTaskPayload(taskRun.payload) === 'discord' &&
    Boolean(getCommunicationChannelFromTaskPayload(taskRun.payload));
  let didSwitchActingUser = false;
  let discordReplyQuoteId: string | null = null;

  try {
    // The actor switch must land before the prompt reaches the sandbox so the
    // worker's sender-vs-acting-user guard passes (critical for runs that
    // start without an acting user, e.g. automation-started tasks).
    didSwitchActingUser = await syncActingUserIdBeforeSandboxDelivery({
      runId: taskRun.id,
      currentActingUserId: previousActingUserId,
      nextActingUserId: auth.userId,
    });

    const client = createSandboxServerRpcClient({
      links: [
        httpBatchLink({
          url: `${taskRun.sandboxServerUrl}/trpc`,
          transformer: superjson,
          headers: () => ({ Authorization: `Bearer ${authToken}` }),
          fetch: (url, init) =>
            fetch(url, { ...init, signal: controller.signal }),
        }),
      ],
    });

    if (shouldTrackDiscordReplyQuote && typeof parsed.prompt === 'string') {
      try {
        const quote = await setLatestUserMessageForReplyQuote(
          'discord',
          taskRun.id,
          {
            text: parsed.prompt,
            userName: promptUserName ?? 'Someone',
          },
        );
        discordReplyQuoteId = quote.id;
      } catch (error) {
        console.warn(
          `[sendSandboxPromptCommand] Failed to persist Discord reply quote for task run ${taskRun.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const result = await client.commands.sendPrompt.mutate({
      prompt:
        outOfBandContext && typeof parsed.prompt === 'string'
          ? withOutOfBandContext(outOfBandContext, parsed.prompt)
          : parsed.prompt,
      quoteText: parsed.prompt,
      taskTool: parsed.taskTool,
      images: parsed.images,
      source: parsed.source,
      clientMessageId: parsed.clientMessageId,
      userName: promptUserName,
      userImageUrl: parsed.userImageUrl,
      // Do not leave the previous actor's turn running after the live
      // credential identity changes (mirrors the API follow-up path).
      autoSteerWhenQueued: requiresActorHandoff
        ? true
        : parsed.autoSteerWhenQueued,
      goalContext,
    });

    if (
      parsed.source === 'web' &&
      typeof parsed.prompt === 'string' &&
      resolveSourceControlProviderFromPayload(taskRun.payload) === 'github'
    ) {
      await trackLatestUserMessageForReplyQuote({
        provider: 'github',
        runId: taskRun.id,
        text: parsed.prompt,
        userName: promptUserName ?? 'Someone',
      });
    }

    return result;
  } catch (error) {
    if (discordReplyQuoteId) {
      await clearLatestUserMessageForReplyQuoteIfId(
        'discord',
        taskRun.id,
        discordReplyQuoteId,
      );
    }

    await releaseOutOfBandContext(outOfBandContext);

    if (didSwitchActingUser) {
      await restoreActingUserIdAfterFailedSandboxDelivery({
        runId: taskRun.id,
        previousActingUserId,
        attemptedActingUserId: auth.userId,
      });
    }

    if (error instanceof TRPCClientError) {
      throw new TRPCError({
        code: 'BAD_GATEWAY',
        message: error.message,
      });
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function answerSandboxUserInputRequestCommand(
  auth: UserAuthSuccess,
  input: z.input<typeof answerSandboxUserInputRequestInputSchema>,
) {
  const parsed = answerSandboxUserInputRequestInputSchema.parse(input);
  const { taskRun } = await getResolvedSandboxTaskRunByTaskId(auth, {
    taskId: parsed.taskId,
  });

  if (!taskRun.sandboxServerUrl) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: "The task hasn't started yet. Try again in a few seconds.",
    });
  }

  await assertSandboxRpcEndpointReachable(taskRun.sandboxServerUrl);

  const authToken = await createRunToken({
    runId: taskRun.id,
    userId: auth.userId,
    timeoutMs: SANDBOX_PROMPT_TOKEN_TIMEOUT_MS,
  });
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    SANDBOX_PROMPT_TIMEOUT_MS,
  );

  const previousActingUserId = taskRun.actingUserId;
  let didSwitchActingUser = false;

  try {
    // Same trusted pre-delivery actor switch as sendSandboxPromptCommand: the
    // worker blocks answers whose sender is not the run's acting user. Note
    // this resolves the actor before delivery rather than through the atomic
    // winner claim (setTrustedRunActingUserOnSuccess) used for contended chat
    // answers, so a losing concurrent answerer may briefly hold attribution.
    didSwitchActingUser = await syncActingUserIdBeforeSandboxDelivery({
      runId: taskRun.id,
      currentActingUserId: previousActingUserId,
      nextActingUserId: auth.userId,
    });

    const client = createSandboxServerRpcClient({
      links: [
        httpBatchLink({
          url: `${taskRun.sandboxServerUrl}/trpc`,
          transformer: superjson,
          headers: () => ({ Authorization: `Bearer ${authToken}` }),
          fetch: (url, init) =>
            fetch(url, { ...init, signal: controller.signal }),
        }),
      ],
    });

    return await client.commands.answerUserInputRequest.mutate({
      requestId: parsed.requestId,
      answers: parsed.answers,
      userName: getAuthenticatedPromptUserName(auth),
    });
  } catch (error) {
    if (didSwitchActingUser) {
      await restoreActingUserIdAfterFailedSandboxDelivery({
        runId: taskRun.id,
        previousActingUserId,
        attemptedActingUserId: auth.userId,
      });
    }

    if (error instanceof TRPCClientError) {
      throw new TRPCError({
        code: 'BAD_GATEWAY',
        message: error.message,
      });
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function getResolvedSandboxTaskRunByTaskId(
  auth: UserAuthSuccess,
  input: { taskId: string },
) {
  const taskAccess = await resolveTaskByIdAccessCommand(auth, input);

  if (taskAccess.kind !== 'resolved') {
    throw new Error(`Task ${input.taskId} not found`);
  }

  return getResolvedSandboxTaskRunForTaskAccess(auth, input, taskAccess);
}

type ResolvedSandboxTaskAccess = Extract<
  TaskByIdAccessResult,
  { kind: 'resolved' }
>;

/**
 * Runs no longer carry PR columns; the session view decorates the run with
 * the task-level pull-request association resolved by tasks/by-id.
 */
type SandboxTaskRunDetail = TaskRunDetail & {
  prRepo: string | null;
  prNumber: number | null;
  pullRequests?: Array<{
    repository: string;
    prNumber: number;
    prUrl?: string;
  }>;
};

function applyResolvedTaskPullRequestFallback<T extends TaskRunDetail>(
  taskRun: T,
  taskTaskRun: ResolvedSandboxTaskAccess['task']['taskRun'],
): T & {
  prRepo: string | null;
  prNumber: number | null;
  pullRequests: NonNullable<
    ResolvedSandboxTaskAccess['task']['taskRun']
  >['pullRequests'];
} {
  return {
    ...taskRun,
    prRepo: taskTaskRun?.prRepo ?? null,
    prNumber: taskTaskRun?.prNumber ?? null,
    pullRequests: taskTaskRun?.pullRequests ?? [],
  };
}

async function getResolvedSandboxTaskRunForTaskAccess(
  auth: UserAuthSuccess,
  input: { taskId: string },
  taskAccess: ResolvedSandboxTaskAccess,
) {
  const { task: taskById } = taskAccess;

  if (!taskById.taskRun) {
    throw new Error(`Task run for task ${input.taskId} not found`);
  }

  const runRow = await db.query.taskRuns.findFirst({
    where: eq(taskRuns.id, taskById.taskRun.id),
    with: { actingUser: true },
  });

  if (!runRow) {
    throw new Error(
      `Task run ${taskById.taskRun.id} for task ${input.taskId} not found`,
    );
  }

  // actingUserId is the only user column on runs; surface it as both `user`
  // and `actingUser` on the detail shape.
  const { actingUser: runActingUser, ...run } = runRow;

  let taskRun: SandboxTaskRunDetail = applyResolvedTaskPullRequestFallback(
    {
      ...run,
      user: runActingUser ?? null,
      actingUser: runActingUser ?? null,
      refetchInterval: undefined,
    },
    taskById.taskRun,
  );

  // If the resolved task run has exited and has a snapshot, check for an active
  // successor (e.g. a SnapshotResume run triggered from Linear). This ensures the
  // web UI shows the running resumed session instead of the old "Went to sleep" state.
  if (isExitedRunStatus(taskRun.status) && taskRun.snapshotId) {
    const successor = await findActiveSuccessorTaskRun(
      taskRun.id,
      auth,
      taskRun.taskId,
    );

    if (successor) {
      taskRun = applyResolvedTaskPullRequestFallback(
        successor,
        taskById.taskRun,
      );
    }
  }

  return {
    task: taskById,
    taskRun: {
      ...taskRun,
      // Whether `enqueueTaskRelaunch` would accept this run, so the
      // failure UI can offer retry exactly where it works instead of
      // approximating the command's rules client-side.
      canRetryFailedStart: await canRetryFailedStart(taskRun),
    },
  };
}

export const updateTaskModelSelectionInputSchema = z.object({
  taskId: z.string(),
  role: z.enum([
    'coding',
    'helper',
    'vision',
    'codeReview',
    'explore',
    'planning',
  ]),
  /**
   * Desired model for the role, or null for the deployment default (for the
   * coding role this re-stamps the deployment's default launch model).
   */
  model: z
    .string()
    .trim()
    .min(1)
    .regex(/^[^/\s]+\/.+$/u, 'Model must use provider/model format.')
    .nullable(),
  /** Desired reasoning level, or null for the deployment role level. */
  reasoningEffort: z.enum(REASONING_EFFORT_VALUES).nullable(),
});

/**
 * Updates one model role for a task: persists the selection on the current
 * run's payload (the worker re-reads it at every harness spawn and snapshot
 * resumes inherit it), then asks the live sandbox to apply it. `application`
 * reports how the live sandbox took the change: `restarted` (idle harness
 * restarted now), `deferred` (applies at the next message), `unavailable`
 * (harness is shutting down), or `offline` (no live sandbox; applies on the
 * next resume).
 */
export async function updateTaskModelSelectionCommand(
  auth: UserAuthSuccess,
  input: z.input<typeof updateTaskModelSelectionInputSchema>,
) {
  const parsed = updateTaskModelSelectionInputSchema.parse(input);
  const { taskRun } = await getResolvedSandboxTaskRunByTaskId(auth, {
    taskId: parsed.taskId,
  });

  try {
    await applyTaskModelSelectionToRun({
      runId: taskRun.id,
      role: parsed.role,
      model: parsed.model,
      reasoningEffort: parsed.reasoningEffort,
    });
  } catch (error) {
    if (error instanceof TaskModelSelectionError) {
      throw new TRPCError({
        code:
          error.code === 'model_not_allowed' || error.code === 'invalid_model'
            ? 'BAD_REQUEST'
            : 'PRECONDITION_FAILED',
        message: error.message,
      });
    }

    throw error;
  }

  let application: 'restarted' | 'deferred' | 'unavailable' | 'offline' =
    'offline';

  if (taskRun.sandboxServerUrl && !isExitedRunStatus(taskRun.status)) {
    try {
      const authToken = await createRunToken({
        runId: taskRun.id,
        userId: auth.userId,
        timeoutMs: SANDBOX_PROMPT_TOKEN_TIMEOUT_MS,
      });
      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(),
        SANDBOX_PROMPT_TIMEOUT_MS,
      );

      try {
        const client = createSandboxServerRpcClient({
          links: [
            httpBatchLink({
              url: `${taskRun.sandboxServerUrl}/trpc`,
              transformer: superjson,
              headers: () => ({ Authorization: `Bearer ${authToken}` }),
              fetch: (url, init) =>
                fetch(url, { ...init, signal: controller.signal }),
            }),
          ],
        });
        const result = await client.commands.applyTaskModelSettings.mutate();
        application = result.application;
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (error) {
      // The selection is persisted; a failed live apply only means it takes
      // effect at the next resume instead of immediately.
      console.warn(
        `[updateTaskModelSelection] Live apply failed for task run ${taskRun.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return { success: true as const, application };
}

export async function takeOverBrowserControlCommand(
  auth: UserAuthSuccess,
  input: { taskId: string },
) {
  const { taskRun } = await getResolvedSandboxTaskRunByTaskId(auth, input);

  const [updatedTaskRun] = await db
    .update(taskRuns)
    .set({ actingUserId: auth.userId })
    .where(eq(taskRuns.id, taskRun.id))
    .returning({
      id: taskRuns.id,
      actingUserId: taskRuns.actingUserId,
    });

  if (!updatedTaskRun) {
    throw new Error(
      'Task run not found or you do not have permission to control this browser',
    );
  }

  return { success: true as const, taskRun: updatedTaskRun };
}

export async function getSandboxSessionByTaskIdCommand(
  auth: UserAuthSuccess,
  input: { taskId: string },
) {
  const taskAccess = await resolveTaskByIdAccessCommand(auth, input);

  if (taskAccess.kind !== 'resolved') {
    return {
      taskId: input.taskId,
      task: null,
      taskRun: null,
      prompt: null,
      sessionState: 'not-found' as const,
      refetchInterval: undefined,
    };
  }

  const { taskRun, task: taskById } =
    await getResolvedSandboxTaskRunForTaskAccess(auth, input, taskAccess);

  // For snapshot-resume runs, the payload doesn't include the original user
  // prompt fields. Resolve them from the source run so the web UI can
  // display the same visible prompt after wake-up. This is runtime dispatch,
  // so branching on payloadKind (not tasks.workflow) is correct here.
  if (
    taskRun.payloadKind === TaskPayloadKind.SnapshotResume &&
    taskRun.sourceRunId
  ) {
    const sourceRun = await db.query.taskRuns.findFirst({
      where: eq(taskRuns.id, taskRun.sourceRunId),
      columns: { payload: true },
    });

    restoreSnapshotResumeVisiblePromptFields(
      taskRun.payload as Record<string, unknown>,
      sourceRun?.payload,
    );
  }

  // Runs no longer carry a separate owner userId; the acting user (already
  // resolved onto the detail shape) is the only human associated with a run.
  const actingUser = taskRun.actingUser ?? taskRun.user;

  const task = taskById;

  const onboardingEnvironmentId = shouldExposeOnboardingEnvironment({
    taskWorkflow: task.workflow,
    taskRunStatus: taskRun.status,
    taskRunPhase: taskRun.taskPhase,
  })
    ? getEnvironmentDefinitionIdFromPayload(taskRun.payload)
    : null;

  // Artifacts are fetched by the client after the shell is visible. They can
  // be numerous and are only needed by optional transcript links and panels.
  const onboardingEnvironment = onboardingEnvironmentId
    ? await db.query.environments.findFirst({
        where: eq(environments.id, onboardingEnvironmentId),
        columns: {
          name: true,
          isVerified: true,
          verificationTaskId: true,
          verifiedAt: true,
          verificationError: true,
        },
      })
    : null;

  const activeVerificationTaskRun = onboardingEnvironment?.verificationTaskId
    ? await db.query.taskRuns.findFirst({
        where: and(
          eq(taskRuns.taskId, onboardingEnvironment.verificationTaskId),
          inArray(taskRuns.status, [...activeRunStatuses]),
        ),
        columns: { status: true },
      })
    : null;

  const onboardingEnvironmentWithVerification = onboardingEnvironment
    ? {
        ...onboardingEnvironment,
        verificationTaskActive: Boolean(activeVerificationTaskRun),
      }
    : null;

  const shouldCheckBootFailureMessages =
    taskRun.status === RunStatus.Failed ||
    taskRun.status === RunStatus.Canceled;

  const shouldCheckHarnessMessages =
    !isExitedRunStatus(taskRun.status) && !isBootingRunStatus(taskRun.status);

  // Check whether the task ever produced messages. Used to distinguish boot
  // failures (no messages) from runtime failures (has conversation history).
  const [bootFailureMessage, firstHarnessMessage] = await Promise.all([
    shouldCheckBootFailureMessages
      ? db.query.taskMessages.findFirst({
          where: eq(taskMessages.runId, taskRun.id),
          columns: { id: true },
        })
      : Promise.resolve(null),
    shouldCheckHarnessMessages
      ? db.query.taskMessages.findFirst({
          where: and(
            eq(taskMessages.runId, taskRun.id),
            isNotNull(taskMessages.role),
            not(eq(taskMessages.role, 'user')),
          ),
          columns: { id: true },
        })
      : Promise.resolve(null),
  ]);

  const hasMessages = !!bootFailureMessage;
  const hasHarnessMessages = !!firstHarnessMessage;
  const payloadPrompt = getTaskRunVisiblePrompt(taskRun);
  // Fall back to durable task-level prompt when the run payload has no visible
  // prompt, so failure UIs can still show the original request.
  const prompt: {
    text?: string;
    images?: string[];
    visibleInTranscript: boolean;
  } | null =
    payloadPrompt ??
    (typeof task.prompt === 'string' && task.prompt.trim().length > 0
      ? {
          text: task.prompt,
          visibleInTranscript: true,
        }
      : null);
  const hasInitialPrompt =
    Boolean(prompt?.text?.trim()) || Boolean(prompt?.images?.length);

  const sessionState = getSessionState(taskRun, {
    hasMessages,
    hasHarnessMessages,
  });
  const resolvedPreviewRuntimeConfig =
    await resolveEffectivePreviewRuntimeConfig({
      runtimeEnv: process.env,
      defaultPreviewProxyBaseUrl: Env.PREVIEW_PROXY_BASE_URL,
      defaultPreviewDomains: Env.PREVIEW_DOMAINS,
    });

  // Dynamically shorten the poll interval when a snapshot is in progress
  // so the client picks up snapshotCreatedAt as quickly as possible.
  const refetchInterval = (() => {
    // Keep polling quickly while waiting for the harness's first message so we
    // can switch from Startup/resume to live chat as soon as output appears.
    if (
      shouldPollForFirstHarnessMessage({
        sessionState,
        taskRunStatus: taskRun.status,
        hasHarnessMessages,
        hasInitialPrompt,
      })
    ) {
      return 2_000;
    }

    if (
      (taskRun.sleepRequestedAt || taskRun.snapshotRequestedAt) &&
      !isExitedRunStatus(taskRun.status) &&
      !taskRun.snapshotCreatedAt &&
      !taskRun.snapshotFailedAt
    ) {
      return 2_000;
    }
    return taskRun.refetchInterval;
  })();

  return {
    taskId: task.id,
    task,
    taskRun: {
      ...taskRun,
      actingUser,
      previewProxyBaseUrl:
        resolvedPreviewRuntimeConfig.effective.previewProxyBaseUrl,
      previewProxySubdomainSuffix:
        resolvedPreviewRuntimeConfig.effective.previewProxySubdomainSuffix,
    },
    prompt,
    onboardingEnvironment: onboardingEnvironmentWithVerification,
    sessionState,
    refetchInterval,
  };
}
