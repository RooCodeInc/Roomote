import { createHash } from 'node:crypto';

import { getTaskUrl } from '@roomote/cloud-agents/server';
import {
  type TaskRun,
  db,
  findReusableGitHubPrFollowUpOwner,
  recordTaskRunLifecycleEvent,
} from '@roomote/db/server';
import {
  getFastAgentParentFromPayload,
  type PullRequestStatus,
  type SourceControlProvider,
} from '@roomote/types';

import {
  deliverFastAgentParentEvent,
  type FastAgentPullRequestContext,
} from '../fast-agent-parent-event';
import { deliverFastAgentParentPrEvent } from './deliver-fast-agent-parent-pr-event';

const PR_FEEDBACK_DELIVERY_LOCK_WAIT_MS = 30_000;

function buildFeedbackId(params: {
  conversation: {
    surface: string;
    workspaceId: string;
    conversationId: string;
  };
  provider: SourceControlProvider;
  host?: string | null;
  repository: string;
  prNumber: number;
  summary: string;
  feedbackSourceIds?: string[];
  reviewTaskId?: string;
  reviewHeadSha?: string;
  reviewResult?: {
    reviewKind: 'initial' | 'sync' | null;
    outcome: string | null;
    findingCount: number | null;
    approvalStatus: 'approved' | 'skipped' | null;
  };
}): string {
  const identityParts = [
    params.conversation.surface,
    params.conversation.workspaceId,
    params.conversation.conversationId,
    params.provider,
    params.host ?? '',
    params.repository,
    String(params.prNumber),
    params.reviewTaskId ?? '',
    params.reviewHeadSha ?? '',
    params.reviewResult?.reviewKind ?? '',
    params.reviewResult?.outcome ?? '',
    String(params.reviewResult?.findingCount ?? ''),
    params.reviewResult?.approvalStatus ?? '',
    params.reviewTaskId && params.reviewHeadSha
      ? ''
      : [...(params.feedbackSourceIds ?? [params.summary.trim()])]
          .sort()
          .join(','),
  ];

  return createHash('sha256')
    .update(identityParts.join(':'))
    .digest('hex')
    .slice(0, 24);
}

/**
 * Best-effort branch for the reusable-owner branch fallback. An empty string is
 * never a real branch, and `findReusableGitHubPrFollowUpOwner` skips the branch
 * lookup rather than matching payloads that stamped an empty branch.
 */
function getPayloadBranchName(payload: TaskRun['payload']): string {
  const record = (payload ?? {}) as Record<string, unknown>;
  const branch = record.branchName ?? record.branch ?? record.headRef;
  return typeof branch === 'string' ? branch : '';
}

/** Pass triaged PR feedback to the Fast conversation that delegated the task. */
export async function notifyFastAgentParentOnPrFeedback(params: {
  run: Pick<TaskRun, 'id' | 'taskId' | 'payload'>;
  reviewTaskId?: string;
  reviewHeadSha?: string;
  pullRequest: {
    provider: SourceControlProvider;
    host?: string | null;
    repository: string;
    number: number;
    title?: string | null;
    url: string;
    status?: PullRequestStatus | null;
  };
  summary: string;
  feedbackSourceIds?: string[];
  suggestedActionQuestion?: string;
  suggestedActionPrompt?: string;
  canonicalDeliveryOwned?: boolean;
  reviewResult?: {
    reviewKind: 'initial' | 'sync' | null;
    outcome: string | null;
    findingCount: number | null;
    approvalStatus: 'approved' | 'skipped' | null;
    headSha: string | null;
  };
}): Promise<boolean> {
  const parent = getFastAgentParentFromPayload(params.run.payload);
  if (!parent) {
    return false;
  }

  // Attribution only. Whichever linked task wins the conversation-scoped claim
  // delivers, so this must not gate delivery: the newest reusable owner is not
  // guaranteed to reach its own delivery path (its notification job can defer
  // past its cap and drop the pending activity, or suppress in its own triage),
  // and a hard skip here would lose the feedback entirely.
  const reusableOwner = await findReusableGitHubPrFollowUpOwner({
    repoFullName: params.pullRequest.repository,
    prNumber: params.pullRequest.number,
    branchName: getPayloadBranchName(params.run.payload),
    sourceControlProvider: params.pullRequest.provider,
    host: params.pullRequest.host,
    fastAgentConversation: parent.conversation,
  });
  const attributedTaskId = reusableOwner?.taskId ?? params.run.taskId;
  const attributedRunId = reusableOwner?.runId ?? params.run.id;

  const feedbackId = buildFeedbackId({
    conversation: parent.conversation,
    provider: params.pullRequest.provider,
    host: params.pullRequest.host,
    repository: params.pullRequest.repository,
    prNumber: params.pullRequest.number,
    summary: params.summary,
    feedbackSourceIds: params.feedbackSourceIds,
    reviewTaskId: params.reviewTaskId,
    reviewHeadSha: params.reviewHeadSha,
    reviewResult: params.reviewResult,
  });
  const notifiedResultKey = `fastAgentParentPrFeedback:${feedbackId}`;
  const pullRequest: FastAgentPullRequestContext = {
    provider: params.pullRequest.provider,
    host: params.pullRequest.host ?? null,
    repository: params.pullRequest.repository,
    number: params.pullRequest.number,
    title: params.pullRequest.title ?? null,
    url: params.pullRequest.url,
    status: params.pullRequest.status ?? null,
  };

  const delivered = await deliverFastAgentParentPrEvent({
    run: params.run,
    deliveryKey: notifiedResultKey,
    logPrefix: 'notifyFastAgentParentOnPrFeedback',
    conversationClaim: {
      conversation: parent.conversation,
      feedbackId,
    },
    canonicalDeliveryOwned: params.canonicalDeliveryOwned,
    deliver: () =>
      deliverFastAgentParentEvent({
        parent,
        event: {
          type: 'pull_request_feedback',
          feedbackId,
          taskId: attributedTaskId,
          runId: attributedRunId,
          taskUrl: getTaskUrl({
            taskId: attributedTaskId,
            utm: {
              source: parent.conversation.surface,
              campaign: 'fast-delegation-pr-feedback',
            },
          }),
          pullRequest,
          summary: params.summary,
          ...(params.reviewResult ? { reviewResult: params.reviewResult } : {}),
          ...(params.suggestedActionQuestion
            ? { suggestedActionQuestion: params.suggestedActionQuestion }
            : {}),
          ...(params.suggestedActionPrompt
            ? { suggestedActionPrompt: params.suggestedActionPrompt }
            : {}),
        },
        lockWaitMs: PR_FEEDBACK_DELIVERY_LOCK_WAIT_MS,
      }),
    recordLifecycle: () =>
      recordTaskRunLifecycleEvent(db, {
        runId: params.run.id,
        taskId: params.run.taskId,
        eventType: 'decision',
        message: `Passed pull request feedback for ${pullRequest.repository ?? 'unknown'}#${pullRequest.number ?? 'unknown'} to the Fast parent orchestrator.`,
        details: {
          reason: 'fast_agent_parent_pr_feedback_event',
          fastAgentSessionId: parent.sessionId,
          provider: pullRequest.provider,
          repository: pullRequest.repository,
          prNumber: pullRequest.number,
          prUrl: pullRequest.url,
        },
      }),
  });
  return params.canonicalDeliveryOwned ? delivered === true : true;
}
