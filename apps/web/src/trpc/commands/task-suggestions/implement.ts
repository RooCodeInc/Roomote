import {
  buildSuggestionTaskPromptText,
  enqueueCloudTask,
} from '@roomote/cloud-agents/server';
import { and, db, eq, or, taskSuggestions } from '@roomote/db/server';
import { CloudTaskType } from '@roomote/types';

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
      id: taskSuggestions.id,
      title: taskSuggestions.title,
      brief: taskSuggestions.brief,
      status: taskSuggestions.status,
      category: taskSuggestions.category,
      priority: taskSuggestions.priority,
      investigationContext: taskSuggestions.investigationContext,
      repositoryIds: taskSuggestions.repositoryIds,
      targetRepositoryFullName: taskSuggestions.targetRepositoryFullName,
      targetEnvironmentId: taskSuggestions.targetEnvironmentId,
      readinessMessage: taskSuggestions.readinessMessage,
      sourceTaskId: taskSuggestions.sourceTaskId,
    })
    .from(taskSuggestions)
    .where(eq(taskSuggestions.id, input.suggestionId))
    .limit(1);

  if (!suggestion) {
    throw new Error('Suggestion not found.');
  }

  if (suggestion.status === 'started') {
    throw new Error('This suggestion has already been implemented.');
  }

  const claimedAt = new Date();
  const [claimedSuggestion] = await db
    .update(taskSuggestions)
    .set({
      status: 'started',
      dismissedAt: null,
      updatedAt: claimedAt,
    })
    .where(
      and(
        eq(taskSuggestions.id, input.suggestionId),
        or(
          eq(taskSuggestions.status, 'open'),
          eq(taskSuggestions.status, 'dismissed'),
        ),
      ),
    )
    .returning({ id: taskSuggestions.id });

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

    const launchResult = await enqueueCloudTask(
      {
        userId: auth.userId,
        type: CloudTaskType.StandardTask,
        payload: {
          repo: resolution.workspace.repoForPayload,
          ...(resolution.workspace.environmentId
            ? { environmentId: resolution.workspace.environmentId }
            : {}),
          description: buildSuggestionTaskPromptText({
            title: suggestion.title,
            brief: suggestion.brief,
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
      {},
    );

    return {
      success: true as const,
      taskId: launchResult.taskId,
      cloudJobId: launchResult.id,
    };
  } catch (error) {
    await db
      .update(taskSuggestions)
      .set({
        status: 'open',
        dismissedAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(taskSuggestions.id, input.suggestionId),
          eq(taskSuggestions.status, 'started'),
        ),
      );

    throw error;
  }
}
