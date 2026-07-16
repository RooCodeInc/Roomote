import {
  type TaskPayload,
  TaskPayloadKind,
  activeRunStatuses,
  populateSnapshotResumeSlackMetadata,
  restoreSnapshotResumeVisiblePromptFields,
  type PreviewTokenContext,
} from '@roomote/types';
import { taskRuns, and, eq, inArray } from '@roomote/db/server';
import { enqueueTask } from '@roomote/cloud-agents/server';

import { db } from '../lib/db';
import { logger, escapeForLog } from '../lib/logger';
import type { ResolvedRequest } from '../services/resolver';

/**
 * Triggers an auto-resume for a resumable task run.
 *
 * This function:
 * 1. Checks if there's already a resume task run in progress
 * 2. Creates a new SnapshotResume task run if not
 * 3. Returns the new task run ID for progress tracking
 *
 * @param resolution - The resolved request with resumable status
 * @param authToken - The validated preview auth token
 * @returns Result with existing or new task run ID, or error
 */
export async function triggerAutoResume(
  resolution: ResolvedRequest,
  authToken: PreviewTokenContext,
): Promise<{
  success: boolean;
  newRunId?: number;
  error?: string;
}> {
  const { taskRun, snapshotId } = resolution;

  if (!taskRun || !snapshotId) {
    logger.warn(
      {
        hasTaskRun: !!taskRun,
        hasSnapshotId: !!snapshotId,
      },
      'Missing required fields for auto-resume',
    );
    return { success: false, error: 'Missing required fields for auto-resume' };
  }

  const identifierLog = {
    sourceRunId: taskRun.id,
    snapshotId: escapeForLog(snapshotId),
  };

  try {
    // Check if there's already a resume task run in progress for this source task run
    const existingResume = await db.query.taskRuns.findFirst({
      where: and(
        eq(taskRuns.sourceRunId, taskRun.id),
        // Cross-task spawned runs also point at their launching run through
        // sourceRunId. Only a sibling run on this task can be its resume.
        eq(taskRuns.taskId, taskRun.taskId),
        inArray(taskRuns.status, [...activeRunStatuses]),
      ),
      columns: { id: true, status: true },
    });

    if (existingResume) {
      logger.info(
        { ...identifierLog, existingRunId: existingResume.id },
        'Resume task run already in progress',
      );
      return { success: true, newRunId: existingResume.id };
    }

    // Extract source task run payload to get repo and environmentId
    const sourcePayload = taskRun.payload as {
      repo?: string;
      environmentId?: string;
    } | null;

    if (!sourcePayload?.repo) {
      logger.warn(
        identifierLog,
        'Source task run has no repository information',
      );
      return {
        success: false,
        error: 'Source task run has no repository information',
      };
    }

    logger.info(
      {
        ...identifierLog,
        repo: escapeForLog(sourcePayload.repo),
        environmentId: sourcePayload.environmentId
          ? escapeForLog(sourcePayload.environmentId)
          : null,
      },
      'Creating auto-resume task run',
    );
    const payload: TaskPayload<typeof TaskPayloadKind.SnapshotResume> = {
      repo: sourcePayload.repo,
      environmentId: sourcePayload.environmentId,
      port: taskRun.port ?? undefined,
      sourceSnapshotId: snapshotId,
      sourceRunId: taskRun.id,
    };
    // Slack thread metadata rides along on the source run's payload; the
    // task-level channel bindings stay on the existing task row.
    populateSnapshotResumeSlackMetadata(payload, {
      sourcePayload: taskRun.payload,
    });
    restoreSnapshotResumeVisiblePromptFields(payload, sourcePayload);

    // Resumes never create tasks and carry no initiator; the resuming human
    // (source run's acting user, else the preview token's user) becomes the
    // new run's acting user.
    const resumeLaunch = await enqueueTask({
      task: {
        type: TaskPayloadKind.SnapshotResume,
        sourceSnapshotId: snapshotId,
        sourceRunId: taskRun.id,
        payload,
      },
      actingUserId: taskRun.actingUserId ?? authToken.userId ?? null,
    });

    logger.info(
      {
        ...identifierLog,
        runId: resumeLaunch.id,
      },
      'Auto-resume launch created successfully',
    );

    return { success: true, newRunId: resumeLaunch.id };
  } catch (error) {
    logger.error({ error, ...identifierLog }, 'Failed to trigger auto-resume');

    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : 'Failed to create resume task run',
    };
  }
}
