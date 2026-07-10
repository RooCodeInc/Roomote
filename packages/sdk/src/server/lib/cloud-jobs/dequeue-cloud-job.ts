import {
  type CloudTask,
  type AuthTokenContext,
  type JobTokenContext,
  type RequestedWorkKind,
  CloudTaskStatus,
  cloudTaskSchema,
  resolveSourceControlProviderFromPayload,
} from '@roomote/types';
import {
  type Run,
  type Task,
  db,
  taskRuns,
  taskPullRequests,
  tasks,
  recordJobLifecycleEvent,
  and,
  eq,
} from '@roomote/db/server';
import { releaseCloudTask, generatePrompt } from '@roomote/cloud-agents/server';

import {
  type GitAuthor,
  fetchEnvVars,
  fetchResolvedRuntimeEnvVars,
  cancelAndReleaseCloudJob,
  createSourceControlTokenForJob,
  type SourceControlRuntimeToken,
  cancelCloudJob,
  reportBootstrapFailure,
  resolveGitAuthor,
  claimJobById,
} from './dequeue-helpers';
import { resolveSlackJobRouting } from './slack-job-routing';

/**
 * Task-level launch context returned alongside the run. The worker previously
 * read these fields off the cloud job row; they now live on the tasks row and
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
  };
}

type DequeueResult =
  | {
      error: true;
      cloudJob?: Run;
    }
  | {
      error: false;
      cloudJob: Run;
      task: DequeuedTaskContext;
      requestedWorkKind: RequestedWorkKind;
      gitHubToken: string;
      sourceControlToken: SourceControlRuntimeToken;
      envVars: Record<string, string>;
      orgAgentInstructions?: string;
      styleGuidance?: string;
      setupOnboardingTask: boolean;
      gitAuthor: GitAuthor;
      prompt: string;
      harnessInstructions?: string;
      artifacts: Record<string, unknown>;
    };

export function shouldInitializeWithoutPrompt(cloudTask: CloudTask): boolean {
  if (
    'description' in cloudTask.payload &&
    typeof cloudTask.payload.description === 'string' &&
    cloudTask.payload.description.trim().length > 0
  ) {
    return false;
  }

  // The description key is present but empty/blank.
  if ('description' in cloudTask.payload) {
    return true;
  }

  // Zod strips `undefined` optional fields, so the `description` key may be
  // absent even though the schema defines it.  When the payload is explicitly
  // marked as `blank` (e.g. a prompt-less Generalist task), honour that flag.
  if ('blank' in cloudTask.payload && cloudTask.payload.blank) {
    return true;
  }

  return false;
}

/**
 * Builds the CloudTask candidate for schema validation from a run row. The
 * discriminated union re-keys on `type`, which is stored as
 * `task_runs.payload_kind`.
 */
function buildCloudTaskCandidate(run: Run): Record<string, unknown> {
  return {
    type: run.payloadKind,
    harness: run.harness,
    payload: run.payload,
    sourceSnapshotId: run.sourceSnapshotId,
    sourceCloudJobId: run.sourceRunId,
  };
}

async function recordJobLifecycleEventSafe(input: {
  cloudJobId: number;
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
    const { cloudJobId, ...rest } = input;
    await recordJobLifecycleEvent(db, { runId: cloudJobId, ...rest });
  } catch (error) {
    console.warn(
      `[dequeueCloudJob] Failed to persist lifecycle event for cloud job ${input.cloudJobId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function recordBootstrapPhase<T>(input: {
  cloudJobId: number;
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

    await recordJobLifecycleEventSafe({
      cloudJobId: input.cloudJobId,
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

    await recordJobLifecycleEventSafe({
      cloudJobId: input.cloudJobId,
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
  payload: Run['payload'],
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

export const dequeueCloudJob = async (
  _auth: AuthTokenContext | JobTokenContext,
  input: {
    cloudJobId: number;
    workerReleaseTag?: string;
    workerVersion?: string;
    workerCommit?: string;
  },
  {
    onBootstrapFailure,
  }: {
    onBootstrapFailure?: (error: Error, cloudJob: Run) => void;
  } = {},
) => {
  try {
    const { cloudJobId, workerReleaseTag, workerVersion, workerCommit } = input;
    const query = claimJobById(cloudJobId);

    const tag = '[dequeueCloudJob]';

    type TransactionResult =
      | { error: true; cloudJob?: Run }
      | {
          error: false;
          cloudJob: Run;
          task: Task;
          cloudTask: CloudTask;
          envVars: Record<string, string>;
          orgAgentInstructions?: string;
          styleGuidance?: string;
          gitAuthor: GitAuthor;
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
      const [dequeued] = await tx.execute<Pick<Run, 'id'>>(query);

      const cloudJob = dequeued
        ? await tx.query.taskRuns.findFirst({
            where: eq(taskRuns.id, dequeued.id),
            with: { task: true },
          })
        : undefined;

      if (!cloudJob) {
        console.error(
          `${tag} Cloud job not found: ${JSON.stringify(dequeued)}`,
        );
        return { error: true, cloudJob };
      }

      const task = cloudJob.task;

      const envVars = await fetchEnvVars(tx, {
        sourceControlProvider: resolveSourceControlProviderFromPayload(
          cloudJob.payload,
        ),
      });
      const settings = await tx.query.deploymentSettings.findFirst({
        columns: {
          globalAgentInstructions: true,
          styleGuidance: true,
        },
      });

      const parsed = cloudTaskSchema.safeParse(
        buildCloudTaskCandidate(cloudJob),
      );

      if (!parsed.success) {
        console.error(
          `${tag} cloudTaskSchema.safeParse failed: ${parsed.error.message} -> ${JSON.stringify(cloudJob)}`,
        );

        reportBootstrapFailure({
          callback: onBootstrapFailure,
          error: parsed.error,
          cloudJob,
          logPrefix: tag,
        });

        await cancelCloudJob(tx, cloudJob.id, 'Cloud job is not valid.', {
          bootstrapFailureReason: 'schema_validation_failed',
          existingArtifacts: cloudJob.artifacts,
        });
        return { error: true, cloudJob };
      }

      const gitAuthor = await resolveGitAuthor(tx, cloudJob);

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
        .where(eq(taskRuns.id, cloudJob.id));

      await recordJobLifecycleEvent(tx, {
        runId: cloudJob.id,
        taskId: cloudJob.taskId,
        eventType: 'started',
        message:
          'Worker claimed dequeued cloud job and started execution bootstrap.',
        details: {
          stage: 'worker_bootstrap',
          status: CloudTaskStatus.Processing,
          vendor: cloudJob.vendor ?? null,
          machineId: cloudJob.machineId ?? null,
          sourceSnapshotId: cloudJob.sourceSnapshotId ?? null,
          environmentId: cloudJob.payload.environmentId ?? null,
          cloudTaskType: cloudJob.payloadKind,
          workerReleaseTag: workerReleaseTag ?? null,
          workerVersion: workerVersion ?? null,
          workerCommit: workerCommit ?? null,
        },
      });

      return {
        error: false,
        cloudJob,
        task,
        cloudTask: parsed.data,
        envVars,
        orgAgentInstructions: settings?.globalAgentInstructions ?? undefined,
        styleGuidance: settings?.styleGuidance ?? undefined,
        gitAuthor,
      };
    });

    if (txResult.error) {
      const { cloudJob } = txResult;

      if (cloudJob) {
        try {
          await releaseCloudTask(cloudJob);
        } catch (error) {
          console.error(
            `${tag} Failed to release lock for job ${cloudJob.id}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }

      return undefined;
    }

    // Phase 2: External API calls — create source-control token (with retries) and
    // generate the prompt.  These happen outside the transaction so the row
    // lock is not held during network round-trips / backoff delays.
    const sourceControlProvider = resolveSourceControlProviderFromPayload(
      txResult.cloudJob.payload,
    );
    const sourceControlToken = await recordBootstrapPhase({
      cloudJobId: txResult.cloudJob.id,
      taskId: txResult.cloudJob.taskId,
      label: 'createSourceControlToken',
      details: {
        cloudTaskType: txResult.cloudJob.payloadKind,
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
        await createSourceControlTokenForJob(txResult.cloudJob, tag),
    });

    if (!sourceControlToken) {
      await recordJobLifecycleEventSafe({
        cloudJobId: txResult.cloudJob.id,
        taskId: txResult.cloudJob.taskId,
        eventType: 'failed',
        message: `Source control token creation failed for cloud job #${txResult.cloudJob.id}.`,
        details: {
          reason: 'source_control_token_creation_failed',
          cloudTaskType: txResult.cloudJob.payloadKind,
          provider: sourceControlProvider,
        },
      });
      await cancelAndReleaseCloudJob(
        txResult.cloudJob,
        'Failed to create source control token.',
        tag,
      );
      return undefined;
    }

    const gitHubToken =
      sourceControlToken.provider === 'github' ? sourceControlToken.token : '';
    const sourceControlArtifacts = sourceControlToken.artifactsPatch ?? {};

    let prompt: string;
    let harnessInstructions: string | undefined;
    let artifacts: Record<string, unknown>;

    if (shouldInitializeWithoutPrompt(txResult.cloudTask)) {
      prompt = '';
      harnessInstructions = undefined;
      artifacts = { ...sourceControlArtifacts };
      await recordJobLifecycleEventSafe({
        cloudJobId: txResult.cloudJob.id,
        taskId: txResult.cloudJob.taskId,
        eventType: 'decision',
        message: `Skipped prompt generation for cloud job #${txResult.cloudJob.id}.`,
        details: {
          reason: 'blank_prompt',
          cloudTaskType: txResult.cloudJob.payloadKind,
        },
      });
    } else {
      try {
        const promptResult = await recordBootstrapPhase({
          cloudJobId: txResult.cloudJob.id,
          taskId: txResult.cloudJob.taskId,
          label: 'generatePrompt',
          details: {
            cloudTaskType: txResult.cloudJob.payloadKind,
          },
          fn: async () =>
            await generatePrompt({
              cloudJob: txResult.cloudJob,
              cloudTask: txResult.cloudTask,
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
            txResult.cloudJob.taskId,
            txResult.cloudJob.payload,
            artifacts.githubPrReviewCommentId,
          );
        }
      } catch (error) {
        const message = `${tag} Failed to generate prompt for cloud job ${txResult.cloudJob.id}: ${error instanceof Error ? error.message : String(error)}`;
        console.error(message);
        await cancelAndReleaseCloudJob(txResult.cloudJob, message, tag);
        return undefined;
      }
    }

    let resolvedEnvVars: Record<string, string>;

    try {
      resolvedEnvVars = await recordBootstrapPhase({
        cloudJobId: txResult.cloudJob.id,
        taskId: txResult.cloudJob.taskId,
        label: 'resolveRuntimeEnvVars',
        details: {
          cloudTaskType: txResult.cloudJob.payloadKind,
          deploymentEnvVarCount: Object.keys(txResult.envVars).length,
        },
        fn: async () =>
          await fetchResolvedRuntimeEnvVars(txResult.envVars, {
            sourceControlProvider: sourceControlToken.provider,
          }),
      });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Failed to resolve harness runtime credentials.';
      await cancelAndReleaseCloudJob(txResult.cloudJob, message, tag);
      return undefined;
    }

    const slackJobRouting = await recordBootstrapPhase({
      cloudJobId: txResult.cloudJob.id,
      taskId: txResult.cloudJob.taskId,
      label: 'resolveLaunchFlagsAndRouting',
      details: {
        cloudTaskType: txResult.cloudJob.payloadKind,
      },
      fn: async () => await resolveSlackJobRouting(txResult.cloudJob),
    });

    const result: DequeueResult = {
      error: false,
      cloudJob: txResult.cloudJob,
      task: buildDequeuedTaskContext(txResult.task),
      requestedWorkKind: txResult.task.requestedWorkKind,
      gitHubToken,
      sourceControlToken,
      envVars: {
        ...resolvedEnvVars,
        ...sourceControlToken.envVars,
      },
      orgAgentInstructions: txResult.orgAgentInstructions,
      styleGuidance: txResult.styleGuidance,
      setupOnboardingTask: slackJobRouting.route.kind === 'setup-onboarding',
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
        .where(eq(taskRuns.id, result.cloudJob.id));

      if (result.harnessInstructions !== undefined) {
        await db
          .update(tasks)
          .set({
            harnessInstructions: result.harnessInstructions,
            updatedAt: new Date(),
          })
          .where(eq(tasks.id, result.cloudJob.taskId));
      }
    } catch (error) {
      const message = `${tag} Failed to persist launch metadata for cloud job ${result.cloudJob.id}: ${
        error instanceof Error ? error.message : String(error)
      }`;
      console.error(message);
      await cancelAndReleaseCloudJob(result.cloudJob, message, tag);
      return undefined;
    }

    const { error: _, ...rest } = result;
    return rest;
  } catch (error) {
    console.error(
      `[dequeueCloudJob] Caught error: ${error instanceof Error ? error.message : String(error)}`,
    );

    throw error;
  }
};
