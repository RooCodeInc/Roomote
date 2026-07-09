import {
  buildSuggestionTaskPromptText,
  enqueueCloudTask,
} from '@roomote/cloud-agents/server';
import { and, db, eq, or, workItems } from '@roomote/db/server';
import { TaskPayloadKind } from '@roomote/types';

import type { UserAuthSuccess } from '@/types';
import { resolveSuggestionLaunchWorkspace } from './launch-resolution';
import { assertSuggestionHistoryEnabled } from './shared';
import {
  getResolvedSuggestionSourceCloudJobsByTaskId,
  getSuggestionHistoryAutomation,
} from './source-cloud-jobs';

export async function implementTaskSuggestionCommand(
  auth: UserAuthSuccess,
  input: { suggestionId: string },
) {
  assertSuggestionHistoryEnabled(auth);

  const [suggestion] = await db
    .select({
      id: workItems.id,
      title: workItems.title,
      brief: workItems.brief,
      status: workItems.status,
      category: workItems.category,
      priority: workItems.priority,
      investigationContext: workItems.investigationContext,
      repositoryIds: workItems.repositoryIds,
      targetRepositoryFullName: workItems.targetRepositoryFullName,
      targetEnvironmentId: workItems.targetEnvironmentId,
      readinessMessage: workItems.readinessMessage,
      sourceTaskId: workItems.sourceTaskId,
    })
    .from(workItems)
    .where(
      and(
        eq(workItems.id, input.suggestionId),
        eq(workItems.kind, 'suggestion'),
      ),
    )
    .limit(1);

  if (!suggestion) {
    throw new Error('Suggestion not found.');
  }

  if (suggestion.status === 'launched') {
    throw new Error('This suggestion has already been implemented.');
  }

  const claimedAt = new Date();
  const [claimedSuggestion] = await db
    .update(workItems)
    .set({
      status: 'launching',
      launchClaimedAt: claimedAt,
      dismissedAt: null,
      updatedAt: claimedAt,
    })
    .where(
      and(
        eq(workItems.id, input.suggestionId),
        eq(workItems.kind, 'suggestion'),
        or(eq(workItems.status, 'open'), eq(workItems.status, 'dismissed')),
      ),
    )
    .returning({ id: workItems.id });

  if (!claimedSuggestion) {
    throw new Error('This suggestion has already been implemented.');
  }

  try {
    const sourceCloudJobByTaskId = suggestion.sourceTaskId
      ? await getResolvedSuggestionSourceCloudJobsByTaskId([
          suggestion.sourceTaskId,
        ])
      : {};
    const automation = getSuggestionHistoryAutomation(
      suggestion.sourceTaskId
        ? sourceCloudJobByTaskId[suggestion.sourceTaskId]
        : undefined,
    );
    const resolution = await resolveSuggestionLaunchWorkspace({
      suggestion,
    });

    if ('failureReason' in resolution) {
      throw new Error(resolution.failureReason);
    }

    const launchResult = await enqueueCloudTask({
      task: {
        type: TaskPayloadKind.StandardTask,
        payload: {
          repo: resolution.workspace.repoForPayload,
          ...(resolution.workspace.environmentId
            ? { environmentId: resolution.workspace.environmentId }
            : {}),
          description: buildSuggestionTaskPromptText({
            title: suggestion.title,
            brief: suggestion.brief ?? '',
            agentType:
              automation === 'onboarding' ? 'setup_onboarding' : automation,
            investigationContext: suggestion.investigationContext,
            readinessMessage: resolution.workspace.readinessMessage,
            category: suggestion.category,
            priority: suggestion.priority,
            targetRepositoryFullName:
              resolution.workspace.targetRepositoryFullName,
          }),
        },
      },
      initiator: { kind: 'user', userId: auth.userId },
      workflow: 'standard',
      surface: 'web',
      trigger: 'manual',
    });

    // Record the launch link on the suggestion work_item. Previously the
    // web-launched suggestion dropped the task association entirely.
    const launchedAt = new Date();
    await db
      .update(workItems)
      .set({
        status: 'launched',
        launchedTaskId: launchResult.taskId,
        launchedAt,
        launchClaimedAt: null,
        dismissedAt: null,
        updatedAt: launchedAt,
      })
      .where(eq(workItems.id, input.suggestionId));

    return {
      success: true as const,
      taskId: launchResult.taskId,
      cloudJobId: launchResult.id,
    };
  } catch (error) {
    await db
      .update(workItems)
      .set({
        status: 'open',
        launchClaimedAt: null,
        dismissedAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(workItems.id, input.suggestionId),
          eq(workItems.kind, 'suggestion'),
          eq(workItems.status, 'launching'),
        ),
      );

    throw error;
  }
}
