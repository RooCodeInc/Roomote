import {
  enqueueTaskWorkspaceSuccessor,
  DeploymentReadOnlyError,
} from '@roomote/cloud-agents/server';
import {
  activeRunStatuses,
  type ResolvedWorkspaceSpec,
  RunStatus,
  TaskPayloadKind,
  type TaskWorkspaceHandoff,
  type WorkspaceGitManifest,
  isExitedRunStatus,
} from '@roomote/types';
import {
  and,
  db,
  desc,
  environmentConfigVersions,
  environments,
  eq,
  inArray,
  isNull,
  markTaskStartParallelCountEndedAt,
  syncTaskStateFromRuns,
  taskRuns,
  tasks,
  taskWorkspaceTransitions,
} from '@roomote/db/server';
import { withSandboxServerRpcClient } from '@roomote/sdk/server';

import type { UserAuthSuccess } from '@/types';
import { getGitBlockReason } from './git-gate';

type TransitionResult =
  | { success: true; transitionId: string; targetRunId: number; noop?: false }
  | { success: true; noop: true }
  | { success: false; transitionId?: string; error: string; blocked?: true };

function buildHandoffPrompt(input: {
  taskTitle: string;
  originalPrompt: string | null;
  handoff: TaskWorkspaceHandoff;
}): string {
  const gitLines = input.handoff.git?.repositories.map(
    (repo) =>
      `- ${repo.repository}: ${repo.branch ?? 'detached'} at ${repo.headSha ?? 'unknown SHA'}${repo.upstream ? ` (tracking ${repo.upstream})` : ''}`,
  );

  return [
    `Continue the existing task "${input.taskTitle}" in the newly selected workspace.`,
    '',
    'This is a fresh runtime and harness session. Re-orient yourself using the checked-out repositories and the target environment instructions. Do not assume files from the previous sandbox exist here.',
    '',
    input.originalPrompt ? `Original task:\n${input.originalPrompt}` : null,
    '',
    gitLines?.length
      ? `Source workspace Git state:\n${gitLines.join('\n')}`
      : null,
    '',
    'Continue from the task-wide conversation history and validate the work in this workspace.',
  ]
    .filter((part): part is string => part !== null)
    .join('\n')
    .slice(0, 12_000);
}

async function failTransition(transitionId: string, error: unknown) {
  await db
    .update(taskWorkspaceTransitions)
    .set({
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(taskWorkspaceTransitions.id, transitionId));
}

export async function requestTaskWorkspaceTransitionCommand(
  auth: UserAuthSuccess,
  input: { taskId: string; targetEnvironmentId: string },
): Promise<TransitionResult> {
  let transitionId: string | undefined;
  let fencedSource:
    | { runId: number; userId: string | null; sandboxServerUrl: string }
    | undefined;

  try {
    const task = await db.query.tasks.findFirst({
      where: and(eq(tasks.id, input.taskId), isNull(tasks.deletedAt)),
      columns: {
        id: true,
        title: true,
        prompt: true,
        workflow: true,
        surface: true,
      },
    });
    if (!task) return { success: false, error: 'Task not found.' };
    if (task.workflow !== 'standard' || task.surface !== 'web') {
      return {
        success: false,
        error:
          'Workspace switching currently supports standard web tasks only.',
      };
    }

    const sourceRun = await db.query.taskRuns.findFirst({
      where: and(
        eq(taskRuns.taskId, task.id),
        inArray(taskRuns.status, [...activeRunStatuses]),
      ),
      orderBy: [desc(taskRuns.createdAt), desc(taskRuns.id)],
    });
    if (!sourceRun) {
      return {
        success: false,
        error: 'This task has no active run to switch.',
      };
    }
    if (sourceRun.payloadKind === TaskPayloadKind.SnapshotResume) {
      return {
        success: false,
        error: 'Snapshot resume runs cannot switch workspaces.',
      };
    }

    const environment = await db.query.environments.findFirst({
      where: and(
        eq(environments.id, input.targetEnvironmentId),
        eq(environments.isEval, false),
        eq(environments.isVerified, true),
        isNull(environments.userId),
      ),
      columns: { id: true, name: true },
    });
    if (!environment) {
      return { success: false, error: 'Select a verified environment.' };
    }
    if (sourceRun.payload.environmentId === environment.id) {
      return { success: true, noop: true };
    }

    const configVersion = await db.query.environmentConfigVersions.findFirst({
      where: eq(environmentConfigVersions.environmentId, environment.id),
      orderBy: [desc(environmentConfigVersions.version)],
    });
    if (!configVersion) {
      return {
        success: false,
        error: 'The target environment has no saved configuration version.',
      };
    }

    const workspace: ResolvedWorkspaceSpec = {
      version: 1,
      environmentId: environment.id,
      environmentConfigVersionId: configVersion.id,
      environmentName: configVersion.name,
      config: configVersion.config,
    };

    const activeTransition = await db.query.taskWorkspaceTransitions.findFirst({
      where: and(
        eq(taskWorkspaceTransitions.taskId, task.id),
        inArray(taskWorkspaceTransitions.status, [
          'requested',
          'quiescing_source',
          'blocked',
          'stopping_source',
          'creating_target',
          'target_queued',
        ]),
      ),
      orderBy: [desc(taskWorkspaceTransitions.createdAt)],
    });
    let transition: { id: string } | undefined;
    if (
      activeTransition?.status === 'blocked' &&
      activeTransition.sourceRunId === sourceRun.id &&
      activeTransition.targetEnvironmentId === environment.id
    ) {
      [transition] = await db
        .update(taskWorkspaceTransitions)
        .set({
          status: 'requested',
          blockedReason: null,
          error: null,
          requestedByUserId: auth.userId,
          updatedAt: new Date(),
        })
        .where(eq(taskWorkspaceTransitions.id, activeTransition.id))
        .returning({ id: taskWorkspaceTransitions.id });
    } else if (activeTransition) {
      return {
        success: false,
        error: 'A workspace switch is already in progress.',
      };
    } else {
      [transition] = await db
        .insert(taskWorkspaceTransitions)
        .values({
          taskId: task.id,
          sourceRunId: sourceRun.id,
          requestedByUserId: auth.userId,
          targetEnvironmentId: environment.id,
          targetEnvironmentConfigVersionId: configVersion.id,
          resolvedWorkspaceSpec: workspace,
        })
        .onConflictDoNothing()
        .returning({ id: taskWorkspaceTransitions.id });
    }
    if (!transition) {
      return {
        success: false,
        error: 'A workspace switch is already in progress.',
      };
    }
    transitionId = transition.id;

    let gitManifest: WorkspaceGitManifest | null = null;
    if (sourceRun.sandboxServerUrl) {
      await db
        .update(taskWorkspaceTransitions)
        .set({ status: 'quiescing_source', updatedAt: new Date() })
        .where(eq(taskWorkspaceTransitions.id, transition.id));

      const preparation = await withSandboxServerRpcClient({
        runId: sourceRun.id,
        userId: auth.userId,
        sandboxServerUrl: sourceRun.sandboxServerUrl,
        call: (client) => client.commands.prepareWorkspaceTransition.mutate(),
      });
      if (!preparation.ready) {
        const blockedReason =
          'Wait for the current agent turn or input request to finish, then try again.';
        await db
          .update(taskWorkspaceTransitions)
          .set({ status: 'blocked', blockedReason, updatedAt: new Date() })
          .where(eq(taskWorkspaceTransitions.id, transition.id));
        return {
          success: false,
          transitionId: transition.id,
          error: blockedReason,
          blocked: true,
        };
      }
      fencedSource = {
        runId: sourceRun.id,
        userId: auth.userId,
        sandboxServerUrl: sourceRun.sandboxServerUrl,
      };

      gitManifest = await withSandboxServerRpcClient({
        runId: sourceRun.id,
        userId: auth.userId,
        sandboxServerUrl: sourceRun.sandboxServerUrl,
        call: (client) => client.commands.inspectWorkspaceGit.query(),
      });
      const blockedReason = getGitBlockReason(gitManifest);
      if (blockedReason) {
        await withSandboxServerRpcClient({
          ...fencedSource,
          call: (client) => client.commands.abortWorkspaceTransition.mutate(),
        });
        fencedSource = undefined;
        await db
          .update(taskWorkspaceTransitions)
          .set({
            status: 'blocked',
            blockedReason,
            gitManifest,
            updatedAt: new Date(),
          })
          .where(eq(taskWorkspaceTransitions.id, transition.id));
        return {
          success: false,
          transitionId: transition.id,
          error: blockedReason,
          blocked: true,
        };
      }
    }

    const handoff: TaskWorkspaceHandoff = {
      summary: `Move task ${task.id} to ${workspace.environmentName}.`,
      sourceRunId: sourceRun.id,
      sourceEnvironmentName:
        sourceRun.resolvedWorkspaceSpec?.environmentName ?? null,
      targetEnvironmentName: workspace.environmentName,
      git: gitManifest,
    };
    const handoffPrompt = buildHandoffPrompt({
      taskTitle: task.title,
      originalPrompt: task.prompt,
      handoff,
    });

    await db
      .update(taskWorkspaceTransitions)
      .set({
        status: 'stopping_source',
        gitManifest,
        handoff,
        updatedAt: new Date(),
      })
      .where(eq(taskWorkspaceTransitions.id, transition.id));

    if (sourceRun.sandboxServerUrl) {
      await withSandboxServerRpcClient({
        runId: sourceRun.id,
        userId: auth.userId,
        sandboxServerUrl: sourceRun.sandboxServerUrl,
        call: (client) =>
          client.commands.cancelTask.mutate({
            terminate: true,
            cancelledBy: { source: 'workspace_switch' },
          }),
      });
      fencedSource = undefined;
    }

    const endedAt = new Date();
    await db.transaction(async (tx) => {
      const [canceled] = await tx
        .update(taskRuns)
        .set({
          status: RunStatus.Canceled,
          cancelRequestedAt: endedAt,
          canceledAt: endedAt,
          terminationReason: 'workspace_rebind',
        })
        .where(
          and(
            eq(taskRuns.id, sourceRun.id),
            inArray(taskRuns.status, [...activeRunStatuses]),
          ),
        )
        .returning({ id: taskRuns.id });
      if (!canceled) {
        const settled = await tx.query.taskRuns.findFirst({
          where: eq(taskRuns.id, sourceRun.id),
          columns: { status: true },
        });
        if (!settled || !isExitedRunStatus(settled.status)) {
          throw new Error('The source run changed while switching.');
        }
        await tx
          .update(taskRuns)
          .set({ terminationReason: 'workspace_rebind' })
          .where(eq(taskRuns.id, sourceRun.id));
      }
      await markTaskStartParallelCountEndedAt(tx, {
        runId: sourceRun.id,
        endedAt,
      });
      await syncTaskStateFromRuns(tx, task.id);
      await tx
        .update(taskWorkspaceTransitions)
        .set({ status: 'creating_target', updatedAt: new Date() })
        .where(eq(taskWorkspaceTransitions.id, transition.id));
    });

    const targetRun = await enqueueTaskWorkspaceSuccessor({
      transitionId: transition.id,
      sourceRunId: sourceRun.id,
      actingUserId: auth.userId,
      workspace,
      handoffPrompt,
    });

    return {
      success: true,
      transitionId: transition.id,
      targetRunId: targetRun.id,
    };
  } catch (error) {
    if (fencedSource) {
      try {
        await withSandboxServerRpcClient({
          ...fencedSource,
          call: (client) => client.commands.abortWorkspaceTransition.mutate(),
        });
      } catch {
        // The sandbox may already be terminating. The run-status fence is the
        // remaining authority in that case.
      }
    }
    if (transitionId) await failTransition(transitionId, error);
    if (error instanceof DeploymentReadOnlyError) {
      return { success: false, transitionId, error: error.code };
    }
    return {
      success: false,
      transitionId,
      error:
        error instanceof Error ? error.message : 'Workspace switch failed.',
    };
  }
}

export async function getTaskWorkspaceTransitionCommand(
  _auth: UserAuthSuccess,
  input: { taskId: string },
) {
  return db.query.taskWorkspaceTransitions.findFirst({
    where: eq(taskWorkspaceTransitions.taskId, input.taskId),
    orderBy: [desc(taskWorkspaceTransitions.createdAt)],
    columns: {
      id: true,
      taskId: true,
      sourceRunId: true,
      targetRunId: true,
      targetEnvironmentId: true,
      status: true,
      blockedReason: true,
      error: true,
      createdAt: true,
      updatedAt: true,
      completedAt: true,
    },
  });
}
