import { enqueueCloudTask } from '@roomote/cloud-agents/server';
import {
  ALL_REPOSITORIES,
  TaskPayloadKind,
  type TaskInitiator,
} from '@roomote/types';

import type {
  AgentSession,
  AgentSessionEventPayload,
  LinearComment,
} from './types';

export type CreateLinearAgentJobOptions = {
  agentSession: AgentSession;
  payload: AgentSessionEventPayload;
  userId?: string;
  /**
   * Repository to use. Defaults to ALL_REPOSITORIES if neither repo nor environmentId is specified.
   * This is used by the LLM router to specify a routed repository.
   */
  repo?: string;
  /**
   * Environment ID to use for multi-repo workspaces.
   * This is used by the LLM router to specify a routed environment.
   */
  environmentId?: string;
};

export type CreateLinearAgentJobResult =
  | { status: 'ok'; jobId: number; taskId: string }
  | { status: 'error'; message: string };

/**
 * Creates a cloud job for a Linear agent session.
 */
export async function createLinearAgentJob({
  agentSession,
  payload,
  userId,
  repo,
  environmentId,
}: CreateLinearAgentJobOptions): Promise<CreateLinearAgentJobResult> {
  const { organizationId, action } = payload;
  const sessionId = agentSession.id;
  const issue = agentSession.issue;
  const comment = agentSession.comment;
  const previousComments = agentSession.previousComments;
  const guidance = agentSession.guidance;
  const user = agentSession.user;

  // Linked senders initiate as themselves; unlinked senders keep their raw
  // Linear identity on the initiator stamp (kind 'user' + externalId).
  const initiator: TaskInitiator = userId
    ? user?.id
      ? {
          kind: 'user',
          externalId: user.id,
          displayName: user.name,
          matchedUserId: userId,
        }
      : { kind: 'user', userId }
    : {
        kind: 'user',
        externalId: user?.id ?? `linear-session:${sessionId}`,
        displayName: user?.name,
      };

  try {
    const launchResult = await enqueueCloudTask({
      task: {
        type: TaskPayloadKind.LinearAgentSession,
        linearSessionId: sessionId,
        linearIssueId: issue.id,
        linearOrganizationId: organizationId,
        payload: {
          repo: repo ?? ALL_REPOSITORIES,
          environmentId,
          sessionId,
          organizationId,
          action,
          issueId: issue.id,
          issueIdentifier: issue.identifier,
          issueTitle: issue.title,
          issueDescription: issue.description,
          issueUrl: issue.url,
          linkedWorkItems: [
            {
              provider: 'linear',
              identifier: issue.identifier,
              url: issue.url,
              title: issue.title,
            },
          ],
          commentBody: comment?.body,
          commentId: comment?.id,
          userId: user?.id,
          username: user?.name,
          previousComments: previousComments?.map((c: LinearComment) => ({
            id: c.id,
            body: c.body,
            userId: c.user?.id,
            username: c.user?.name,
            createdAt: c.createdAt,
          })),
          guidance: guidance
            ? {
                system: guidance.system,
                instructions: guidance.instructions,
              }
            : undefined,
        },
      },
      initiator,
      workflow: 'standard',
      surface: 'linear',
      trigger: 'message',
      channels: {
        linearSessionId: sessionId,
        linearIssueId: issue.id,
        linearOrganizationId: organizationId,
      },
    });

    console.log(
      `[createLinearAgentJob] Created cloud job ${launchResult.id} for Linear session ${sessionId}`,
    );

    return {
      status: 'ok',
      jobId: launchResult.id,
      taskId: launchResult.taskId,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unknown error creating job';
    console.error(`[createLinearAgentJob] Failed to create job: ${message}`);
    return { status: 'error', message };
  }
}
