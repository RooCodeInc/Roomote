import {
  type CloudTaskPayload,
  CloudTaskType,
  activeCloudTaskStatuses,
  populateSnapshotResumeSlackMetadata,
  restoreSnapshotResumeVisiblePromptFields,
  type PreviewTokenContext,
} from '@roomote/types';
import { cloudJobs, and, eq, inArray } from '@roomote/db/server';
import { enqueueCloudTask } from '@roomote/cloud-agents/server';

import { db } from '../lib/db';
import { logger, escapeForLog } from '../lib/logger';
import type { ResolvedRequest } from '../services/resolver';

/**
 * Triggers an auto-resume for a resumable cloud job.
 *
 * This function:
 * 1. Checks if there's already a resume job in progress
 * 2. Creates a new SnapshotResume cloud job if not
 * 3. Returns the new cloud job ID for progress tracking
 *
 * @param resolution - The resolved request with resumable status
 * @param authToken - The validated preview auth token
 * @returns Result with existing or new cloud job ID, or error
 */
export async function triggerAutoResume(
  resolution: ResolvedRequest,
  authToken: PreviewTokenContext,
): Promise<{
  success: boolean;
  newCloudJobId?: number;
  error?: string;
}> {
  const { cloudJob, snapshotId } = resolution;

  if (!cloudJob || !snapshotId) {
    logger.warn(
      {
        hasCloudJob: !!cloudJob,
        hasSnapshotId: !!snapshotId,
      },
      'Missing required fields for auto-resume',
    );
    return { success: false, error: 'Missing required fields for auto-resume' };
  }

  const identifierLog = {
    sourceCloudJobId: cloudJob.id,
    snapshotId: escapeForLog(snapshotId),
  };

  try {
    // Check if there's already a resume job in progress for this source job
    const existingResume = await db.query.cloudJobs.findFirst({
      where: and(
        eq(cloudJobs.sourceCloudJobId, cloudJob.id),
        inArray(cloudJobs.status, [...activeCloudTaskStatuses]),
      ),
      columns: { id: true, status: true },
    });

    if (existingResume) {
      logger.info(
        { ...identifierLog, existingJobId: existingResume.id },
        'Resume job already in progress',
      );
      return { success: true, newCloudJobId: existingResume.id };
    }

    // Extract source job payload to get repo and environmentId
    const sourcePayload = cloudJob.payload as {
      repo?: string;
      environmentId?: string;
    } | null;

    if (!sourcePayload?.repo) {
      logger.warn(identifierLog, 'Source job has no repository information');
      return {
        success: false,
        error: 'Source job has no repository information',
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
      'Creating auto-resume job',
    );
    const payload: CloudTaskPayload<CloudTaskType.SnapshotResume> = {
      repo: sourcePayload.repo,
      environmentId: sourcePayload.environmentId,
      port: cloudJob.port ?? undefined,
      sourceSnapshotId: snapshotId,
      sourceCloudJobId: cloudJob.id,
    };
    populateSnapshotResumeSlackMetadata(payload, {
      sourcePayload: cloudJob.payload,
      threadTs: cloudJob.slackThreadTs,
    });
    restoreSnapshotResumeVisiblePromptFields(payload, sourcePayload);

    const resumeLaunch = await enqueueCloudTask({
      userId: cloudJob.userId ?? authToken.userId,
      sourceSnapshotId: snapshotId,
      sourceCloudJobId: cloudJob.id,
      type: CloudTaskType.SnapshotResume,
      ...(cloudJob.slackThreadTs
        ? { slackThreadTs: cloudJob.slackThreadTs }
        : {}),
      payload,
    });

    logger.info(
      {
        ...identifierLog,
        cloudJobId: resumeLaunch.id,
      },
      'Auto-resume launch created successfully',
    );

    return { success: true, newCloudJobId: resumeLaunch.id };
  } catch (error) {
    logger.error({ error, ...identifierLog }, 'Failed to trigger auto-resume');

    return {
      success: false,
      error:
        error instanceof Error ? error.message : 'Failed to create resume job',
    };
  }
}
