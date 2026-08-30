import {
  type TaskSpec,
  type AuthTokenContext,
  type RunTokenContext,
  type RequestedWorkKind,
  type TaskGoal,
  RunStatus,
  TaskPayloadKind,
  taskSpecSchema,
  resolveSourceControlProviderFromPayload,
} from '@roomote/types';
import {
  type TaskRun,
  type Task,
  db,
  taskRuns,
  taskPullRequests,
  tasks,
  recordTaskRunLifecycleEvent,
  and,
  eq,
} from '@roomote/db/server';
import { releaseTaskRun, generatePrompt } from '@roomote/cloud-agents/server';

import {
  type GitAuthor,
  fetchEnvVars,
  fetchResolvedRuntimeEnvVars,
  resolveTaskRunSourceControlProviders,
  cancelAndReleaseTaskRun,
  createSourceControlTokenForTaskRun,
  type SourceControlRuntimeToken,
  cancelTaskRun,
  notifyCanceledTaskRunOnSettle,
  reportBootstrapFailure,
  resolveGitAuthor,
  claimJobById,
} from './dequeue-helpers';
import { resolveSlackTaskRunRouting } from './slack-task-run-routing';
import { markGithubPrReviewCheckInProgress } from './github-pr-review-check';

/**
 * Task-level launch context returned alongside the run. The worker previously
 * read these fields off the task run row; they now live on the tasks row and
 * are joined into the dequeue/resume responses explicitly.
 */
export type DequeuedTaskContext = {
  id: string;
  title: string;
  /** The initial task prompt (tasks.prompt); per-attempt prompt is top-level. */
  prompt: string | null;
  harnessInstructions: string | null;
  requestedWorkKind: RequestedWorkKind;
  slackChannelId: string | null;
  slackThreadTs: string | null;
  linearSessionId: string | null;
  linearIssueId: string | null;
  linearOrganizationId: string | null;
  goal: TaskGoal | null;
};

export function buildDequeuedTaskContext(task: Task): DequeuedTaskContext {
  return {
    id: task.id,
    title: task.title,
    prompt: task.prompt ?? null,
    harnessInstructions: task.harnessInstructions ?? null,
    requestedWorkKind: task.requestedWorkKind,
    slackChannelId: task.slackChannelId ?? null,
    slackThreadTs: task.slackThreadTs ?? null,
    linearSessionId: task.linearSessionId ?? null,
    linearIssueId: task.linearIssueId ?? null,
    linearOrganizationId: task.linearOrganizationId ?? null,
    goal:
      task.goalObjective &&
      task.goalStatus &&
      task.goalMaxContinuations !== null
        ? {
            objective: task.goalObjective,
            generation: task.goalLastContinuationId,
            status: task.goalStatus,
            maxContinuations: task.goalMaxContinuations,
            continuationsUsed: task.goalContinuationsUsed,
            blockedReason: task.goalBlockedReason,
            completedAt: task.goalCompletedAt,
          }
        : null,
  };
}

type DequeueResult =
  | {
      error: true;
      taskRun?: TaskRun;
    }
  | {
      error: false;
      taskRun: TaskRun;
      task: DequeuedTaskContext;
      requestedWorkKind: RequestedWorkKind;
      gitHubToken: string;
      sourceControlToken: SourceControlRuntimeToken;
      envVars: Record<string, string>;
      orgAgentInstructions?: string;
      setupOnboardingTask: boolean;
      gitAuthor: GitAuthor;
      prompt: string;
      harnessInstructions?: string;
      artifacts: Record<string, unknown>;
    };

export function shouldInitializeWithoutPrompt(taskSpec: TaskSpec): boolean {
  if (
    'description' in taskSpec.payload &&
    typeof taskSpec.payload.description === 'string' &&
    taskSpec.payload.description.trim().length > 0
  ) {
    return false;
  }

  // The description key is present but empty/blank.
  if ('description' in taskSpec.payload) {
    return true;
  }

  // Zod strips `undefined` optional fields, so the `description` key may be
  // absent even though the schema defines it.  When the payload is explicitly
  // marked as `blank` (e.g. a prompt-less standard task), honour that flag.
  if ('blank' in taskSpec.payload && taskSpec.payload.blank) {
    return true;
  }

  return false;
}

/**
 * Builds the TaskSpec candidate for schema validation from a run row. The
 * discriminated union re-keys on `type`, which is stored as
 * `task_runs.payload_kind`.
 */
function buildTaskSpecCandidate(
  run: TaskRun,
  task: Task,
): Record<string, unknown> {
  return {
    type: run.payloadKind,
    harness: run.harness,
    payload: run.payload,
    sourceSnapshotId: run.sourceSnapshotId,
    sourceRunId: run.sourceRunId,
    linearSessionId: task.linearSessionId,
    linearIssueId: task.linearIssueId,
    linearOrganizationId: task.linearOrganizationId,
  };
}

async function recordTaskRunLifecycleEventSafe(input: {
  runId: number;
  taskId?: string;
  eventType:
    | 'decision'
    | 'enqueued'
    | 'started'
    | 'completed'
    | 'failed'
    | 'phase';
  message: string;
  details?: Record<string, unknown>;
}) {
  try {
    const { runId, ...rest } = input;
    await recordTaskRunLifecycleEvent(db, { runId: runId, ...rest });
  } catch (error) {
    console.warn(
      `[dequeueTaskRun] Failed to persist lifecycle event for task run ${input.runId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function recordBootstrapPhase<T>(input: {
  runId: number;
  taskId?: string;
  label: string;
  details?: Record<string, unknown>;
  classifyResult?: (
    result: T,
  ) => { outcome: 'ok' | 'failed'; error?: string } | undefined;
  fn: () => Promise<T>;
}): Promise<T> {
  const startedAtMs = Date.now();

  try {
    const result = await input.fn();
    const endedAtMs = Date.now();
    const classification = input.classifyResult?.(result);

    await recordTaskRunLifecycleEventSafe({
      runId: input.runId,
      taskId: input.taskId,
      eventType: 'phase',
      message: input.label,
      details: {
        phase: input.label,
        startedAtMs,
        endedAtMs,
        durationMs: endedAtMs - startedAtMs,
        outcome: classification?.outcome ?? 'ok',
        ...(classification?.error ? { error: classification.error } : {}),
        ...(input.details ?? {}),
      },
    });

    return result;
  } catch (error) {
    const endedAtMs = Date.now();

    await recordTaskRunLifecycleEventSafe({
      runId: input.runId,
      taskId: input.taskId,
      eventType: 'phase',
      message: input.label,
      details: {
        phase: input.label,
        startedAtMs,
        endedAtMs,
        durationMs: endedAtMs - startedAtMs,
        outcome: 'failed',
        error: error instanceof Error ? error.message : String(error),
        ...(input.details ?? {}),
      },
    });

    throw error;
  }
}

/**
 * The PR review summary comment id is a GitHub-native identifier of the PR
 * linkage, so it persists on the task's task_pull_requests row (inserted at
 * enqueue for PR-triggered launches).
 */
async function persistGithubPrReviewCommentId(
  taskId: string,
  payload: TaskRun['payload'],
  commentId: number,
): Promise<void> {
  const repository =
    'repo' in payload && typeof payload.repo === 'string' ? payload.repo : null;
  const prNumber =
    'prNumber' in payload && typeof payload.prNumber === 'number'
      ? payload.prNumber
      : null;

  if (!repository || !prNumber) {
    return;
  }

  await db
    .update(taskPullRequests)
    .set({ githubReviewCommentId: commentId, updatedAt: new Date() })
    .where(
      and(
        eq(taskPullRequests.taskId, taskId),
        eq(taskPullRequests.sourceControlProvider, 'github'),
        eq(taskPullRequests.repository, repository),
        eq(taskPullRequests.prNumber, prNumber),
      ),
    );
}

export const dequeueTaskRun = async (
  _auth: AuthTokenContext | RunTokenContext,
  input: {
    runId: number;
    workerReleaseTag?: string;
    workerVersion?: string;
    workerCommit?: string;
  },
  {
    onBootstrapFailure,
  }: {
    onBootstrapFailure?: (error: Error, taskRun: TaskRun) => void;
  } = {},
) => {
  try {
    const { runId, workerReleaseTag, workerVersion, workerCommit } = input;
    const query = claimJobById(runId);

    const tag = '[dequeueTaskRun]';

    type TransactionResult =
      | { error: true; taskRun?: TaskRun }
      | {
          error: false;
          taskRun: TaskRun;
          task: Task;
          taskSpec: TaskSpec;
          envVars: Record<string, string>;
          orgAgentInstructions?: string;
          gitAuthor: GitAuthor;
          sourceControlProviders: Awaited<
            ReturnType<typeof resolveTaskRunSourceControlProviders>
          >;
        };

    // Phase 1: Transaction — claim the run and fetch all data needed for
    // subsequent steps.  No external API calls happen here, keeping the
    // row lock short-lived.
    const txResult: TransactionResult = await db.transaction(async (tx) => {
      // Use a single UPDATE query with a subquery to atomically claim exactly one run.
      // PostgreSQL automatically applies row-level locking during UPDATE:
      // 1. The subquery finds the first matching run and locks it with FOR UPDATE SKIP LOCKED.
      // 2. SKIP LOCKED means if another transaction has already locked a row, skip it.
      // 3. The UPDATE then modifies only that specific locked row.
      // 4. This ensures only ONE worker can claim each run, even with concurrent requests.
      const [dequeued] = await tx.execute<Pick<TaskRun, 'id'>>(query);

      const taskRun = dequeued
        ? await tx.query.taskRuns.findFirst({
            where: eq(taskRuns.id, dequeued.id),
            with: { task: true },
          })
        : undefined;

      if (!taskRun) {
        console.error(`${tag} Task run not found: ${JSON.stringify(dequeued)}`);
        return { error: true, taskRun };
      }

      const task = taskRun.task;

      const sourceControlProviders = await resolveTaskRunSourceControlProviders(
        taskRun,
        tx,
      );
      const envVars = await fetchEnvVars(tx, {
        sourceControlProvider: sourceControlProviders,
      });
      const settings = await tx.query.deploymentSettings.findFirst({
        columns: {
          globalAgentInstructions: true,
        },
      });

      const parsed = taskSpecSchema.safeParse(
        buildTaskSpecCandidate(taskRun, task),
      );

      if (!parsed.success) {
        console.error(
          `${tag} taskSpecSchema.safeParse failed: ${parsed.error.message} -> ${JSON.stringify(taskRun)}`,
        );

        reportBootstrapFailure({
          callback: onBootstrapFailure,
          error: parsed.error,
          taskRun,
          logPrefix: tag,
        });

        await cancelTaskRun(tx, taskRun.id, 'Task run is not valid.', {
          bootstrapFailureReason: 'schema_validation_failed',
          existingArtifacts: taskRun.artifacts,
        });
        return { error: true, taskRun };
      }

      const gitAuthor = await resolveGitAuthor(tx, taskRun);

      // Stamp startedAt as soon as the worker has claimed the dequeued run.
      // Prompt generation and token creation happen afterwards and can take
      // noticeable time, but the worker has already started processing.
      await tx
        .update(taskRuns)
        .set({
          startedAt: new Date(),
          ...(workerReleaseTag !== undefined ? { workerReleaseTag } : {}),
          ...(workerVersion !== undefined ? { workerVersion } : {}),
          ...(workerCommit !== undefined ? { workerCommit } : {}),
        })
        .where(eq(taskRuns.id, taskRun.id));

      await recordTaskRunLifecycleEvent(tx, {
        runId: taskRun.id,
        taskId: taskRun.taskId,
        eventType: 'started',
        message:
          'Worker claimed dequeued task run and started execution bootstrap.',
        details: {
          stage: 'worker_bootstrap',
          status: RunStatus.Processing,
          vendor: taskRun.vendor ?? null,
          machineId: taskRun.machineId ?? null,
          sourceSnapshotId: taskRun.sourceSnapshotId ?? null,
          environmentId: taskRun.payload.environmentId ?? null,
          payloadKind: taskRun.payloadKind,
          workerReleaseTag: workerReleaseTag ?? null,
          workerVersion: workerVersion ?? null,
          workerCommit: workerCommit ?? null,
        },
      });

      return {
        error: false,
        taskRun,
        task,
        taskSpec: parsed.data,
        envVars,
        orgAgentInstructions: settings?.globalAgentInstructions ?? undefined,
        gitAuthor,
        sourceControlProviders,
      };
    });

    if (txResult.error) {
      const { taskRun } = txResult;

      if (taskRun) {
        try {
          await releaseTaskRun(taskRun);
        } catch (error) {
          console.error(
            `${tag} Failed to release lock for run ${taskRun.id}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }

        await notifyCanceledTaskRunOnSettle(taskRun);
      }

      return undefined;
    }

    // Phase 2: External API calls — create source-control token (with retries) and
    // generate the prompt.  These happen outside the transaction so the row
    // lock is not held during network round-trips / backoff delays.
    const sourceControlProvider = resolveSourceControlProviderFromPayload(
      txResult.taskRun.payload,
    );
    const sourceControlToken = await recordBootstrapPhase({
      runId: txResult.taskRun.id,
      taskId: txResult.taskRun.taskId,
      label: 'createSourceControlToken',
      details: {
        payloadKind: txResult.taskRun.payloadKind,
        provider: sourceControlProvider,
      },
      classifyResult: (token) =>
        token
          ? undefined
          : {
              outcome: 'failed',
              error:
                'Source control token creation exhausted retries and returned no token.',
            },
      fn: async () =>
        await createSourceControlTokenForTaskRun(txResult.taskRun, tag),
    });

    if (!sourceControlToken) {
      await recordTaskRunLifecycleEventSafe({
        runId: txResult.taskRun.id,
        taskId: txResult.taskRun.taskId,
        eventType: 'failed',
        message: `Source control token creation failed for task run #${txResult.taskRun.id}.`,
        details: {
          reason: 'source_control_token_creation_failed',
          payloadKind: txResult.taskRun.payloadKind,
          provider: sourceControlProvider,
        },
      });
      await cancelAndReleaseTaskRun(
        txResult.taskRun,
        'Failed to create source control token.',
        tag,
      );
      return undefined;
    }

    const gitHubToken = sourceControlToken.envVars.GH_TOKEN ?? '';
    const sourceControlArtifacts = sourceControlToken.artifactsPatch ?? {};

    if (
      gitHubToken &&
      (txResult.taskRun.payloadKind === TaskPayloadKind.GithubPrReview ||
        txResult.taskRun.payloadKind === TaskPayloadKind.GithubPrReviewSync)
    ) {
      await markGithubPrReviewCheckInProgress({
        taskId: txResult.taskRun.taskId,
        runId: txResult.taskRun.id,
        gitHubToken,
      });
    }

    let prompt: string;
    let harnessInstructions: string | undefined;
    let artifacts: Record<string, unknown>;

    if (shouldInitializeWithoutPrompt(txResult.taskSpec)) {
      prompt = '';
      harnessInstructions = undefined;
      artifacts = { ...sourceControlArtifacts };
      await recordTaskRunLifecycleEventSafe({
        runId: txResult.taskRun.id,
        taskId: txResult.taskRun.taskId,
        eventType: 'decision',
        message: `Skipped prompt generation for task run #${txResult.taskRun.id}.`,
        details: {
          reason: 'blank_prompt',
          payloadKind: txResult.taskRun.payloadKind,
        },
      });
    } else {
      try {
        const promptResult = await recordBootstrapPhase({
          runId: txResult.taskRun.id,
          taskId: txResult.taskRun.taskId,
          label: 'generatePrompt',
          details: {
            payloadKind: txResult.taskRun.payloadKind,
          },
          fn: async () =>
            await generatePrompt({
              taskRun: txResult.taskRun,
              taskSpec: txResult.taskSpec,
              gitHubToken,
            }),
        });

        prompt = promptResult.prompt;
        harnessInstructions = promptResult.harnessInstructions;
        artifacts = {
          ...sourceControlArtifacts,
          ...promptResult.artifacts,
        };

        // Persist critical artifacts outside the transaction. The PR review
        // summary comment id lives on the task's pull-request row.
        if (typeof artifacts.githubPrReviewCommentId === 'number') {
          await persistGithubPrReviewCommentId(
            txResult.taskRun.taskId,
            txResult.taskRun.payload,
            artifacts.githubPrReviewCommentId,
          );
        }
      } catch (error) {
        const message = `${tag} Failed to generate prompt for task run ${txResult.taskRun.id}: ${error instanceof Error ? error.message : String(error)}`;
        console.error(message);
        await cancelAndReleaseTaskRun(txResult.taskRun, message, tag);
        return undefined;
      }
    }

    let resolvedEnvVars: Record<string, string>;

    try {
      resolvedEnvVars = await recordBootstrapPhase({
        runId: txResult.taskRun.id,
        taskId: txResult.taskRun.taskId,
        label: 'resolveRuntimeEnvVars',
        details: {
          payloadKind: txResult.taskRun.payloadKind,
          deploymentEnvVarCount: Object.keys(txResult.envVars).length,
        },
        fn: async () =>
          await fetchResolvedRuntimeEnvVars(txResult.envVars, {
            sourceControlProvider: txResult.sourceControlProviders,
          }),
      });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Failed to resolve harness runtime credentials.';
      await cancelAndReleaseTaskRun(txResult.taskRun, message, tag);
      return undefined;
    }

    const slackTaskRunRouting = await recordBootstrapPhase({
      runId: txResult.taskRun.id,
      taskId: txResult.taskRun.taskId,
      label: 'resolveLaunchFlagsAndRouting',
      details: {
        payloadKind: txResult.taskRun.payloadKind,
      },
      fn: async () => await resolveSlackTaskRunRouting(txResult.taskRun),
    });

    const result: DequeueResult = {
      error: false,
      taskRun: txResult.taskRun,
      task: buildDequeuedTaskContext(txResult.task),
      requestedWorkKind: txResult.task.requestedWorkKind,
      gitHubToken,
      sourceControlToken,
      envVars: {
        ...resolvedEnvVars,
        ...sourceControlToken.envVars,
      },
      orgAgentInstructions: txResult.orgAgentInstructions,
      setupOnboardingTask:
        slackTaskRunRouting.route.kind === 'setup-onboarding',
      gitAuthor: txResult.gitAuthor,
      prompt,
      harnessInstructions,
      artifacts,
    };

    try {
      // Per-attempt prompt and artifacts persist on the run; the generated
      // harness instructions persist on the task (tasks.harnessInstructions).
      await db
        .update(taskRuns)
        .set({
          prompt: result.prompt,
          artifacts: result.artifacts,
        })
        .where(eq(taskRuns.id, result.taskRun.id));

      if (result.harnessInstructions !== undefined) {
        await db
          .update(tasks)
          .set({
            harnessInstructions: result.harnessInstructions,
            updatedAt: new Date(),
          })
          .where(eq(tasks.id, result.taskRun.taskId));
      }
    } catch (error) {
      const message = `${tag} Failed to persist launch metadata for task run ${result.taskRun.id}: ${
        error instanceof Error ? error.message : String(error)
      }`;
      console.error(message);
      await cancelAndReleaseTaskRun(result.taskRun, message, tag);
      return undefined;
    }

    const { error: _, ...rest } = result;
    return rest;
  } catch (error) {
    console.error(
      `[dequeueTaskRun] Caught error: ${error instanceof Error ? error.message : String(error)}`,
    );

    throw error;
  }
};
