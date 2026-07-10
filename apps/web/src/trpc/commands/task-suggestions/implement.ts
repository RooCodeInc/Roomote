import {
  buildSuggestionTaskPromptText,
  enqueueCloudTask,
} from '@roomote/cloud-agents/server';
import {
  and,
  cancelTaskRunDirect,
  claimWorkItem,
  db,
  eq,
  finalizeWorkItemLaunched,
  releaseWorkItemClaim,
  workItems,
} from '@roomote/db/server';
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

  // The web surface may relaunch a dismissed suggestion, so `dismissed` joins
  // the claimable set here (other surfaces omit it). Shared CAS also covers
  // stale-`launching` recovery.
  const claimedSuggestion = await claimWorkItem(db, {
    id: input.suggestionId,
    additionalClaimableStatuses: ['dismissed'],
    extraConditions: [eq(workItems.kind, 'suggestion')],
  });

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
    const finalized = await finalizeWorkItemLaunched(db, {
      id: input.suggestionId,
      taskId: launchResult.taskId,
      claimedAt: claimedSuggestion.launchClaimedAt,
      clearDismissedAt: true,
    });

    if (!finalized) {
      // The task is already enqueued but the fencing guard rejected the
      // finalize (our stale claim was reclaimed by another launcher), so the
      // run is orphaned from the work item. Best-effort cancel it while it is
      // still pre-sandbox, and log loudly either way with the cancel outcome.
      let cancelNote = 'orphaned run left running';

      try {
        const canceled = await cancelTaskRunDirect({
          runId: launchResult.id,
          error:
            'Canceled: work-item launch finalize lost the claim fencing guard',
        });
        cancelNote = canceled
          ? 'orphaned run canceled'
          : 'orphaned run cancel did not apply (already started or terminal)';
      } catch (cancelError) {
        cancelNote = `orphaned run cancel failed: ${
          cancelError instanceof Error
            ? cancelError.message
            : String(cancelError)
        }`;
      }

      console.warn(
        `[implementTaskSuggestion] finalize lost the fencing guard for work item ${input.suggestionId}; task ${launchResult.taskId} (run ${launchResult.id}) was orphaned — ${cancelNote}.`,
      );
    }

    return {
      success: true as const,
      taskId: launchResult.taskId,
      cloudJobId: launchResult.id,
    };
  } catch (error) {
    // Release the claim back to `open` (never reverts a `launched` item; the
    // shared guard requires status='launching').
    await releaseWorkItemClaim(db, {
      id: input.suggestionId,
      claimedAt: claimedSuggestion.launchClaimedAt,
      clearDismissedAt: true,
      extraConditions: [eq(workItems.kind, 'suggestion')],
    });

    throw error;
  }
}
