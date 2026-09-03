import type { Context } from 'hono';

import {
  enqueueTask,
  fastAgentConversationRepository,
  getTaskUrl,
} from '@roomote/cloud-agents/server';
import { and, db, eq, inArray, repositories } from '@roomote/db/server';
import {
  buildFastAgentSessionAttachment,
  sourceControlProviderDescriptors,
  TaskPayloadKind,
  type FastAgentParent,
  type FastAgentSourceControlSurface,
  type TaskLaunchRequest,
  type TaskPayload,
} from '@roomote/types';

import type { Variables } from '../../types';
import type { McpAuth } from '../mcp/middleware';

const SOURCE_CONTROL_PROVIDERS: FastAgentSourceControlSurface[] = [
  'github',
  'gitlab',
  'bitbucket',
  'ado',
  'gitea',
];

/**
 * Launches the structured review pipeline on a pull request, on behalf of a
 * Fast session. The review task attaches to the requesting session (so it
 * shows up there like any delegated task) and, unlike automatic reviews, its
 * settle announces back into that session because the requester is waiting.
 */
export async function handlePrReviewLaunch(
  c: Context<{ Variables: Variables & { mcpAuth: McpAuth } }>,
  auth: { userId: string },
  body: TaskLaunchRequest,
) {
  const repositoryFullName = body.repo?.trim();
  const prNumber = body.prNumber;

  if (!repositoryFullName || !prNumber) {
    return c.json(
      { error: 'pr-review launches require repo and prNumber.' },
      400,
    );
  }

  const repositoryRows = await db.query.repositories.findMany({
    where: and(
      eq(repositories.fullName, repositoryFullName),
      eq(repositories.isActive, true),
      inArray(repositories.sourceControlProvider, SOURCE_CONTROL_PROVIDERS),
    ),
    columns: { id: true, sourceControlProvider: true, host: true },
  });

  if (repositoryRows.length === 0) {
    return c.json(
      { error: `Repository "${repositoryFullName}" is not connected.` },
      404,
    );
  }
  if (repositoryRows.length > 1) {
    const candidates = repositoryRows
      .map((row) => `${row.sourceControlProvider}:${row.host ?? 'default'}`)
      .join(', ');
    return c.json(
      {
        error: `Repository "${repositoryFullName}" exists on multiple providers or hosts (${candidates}); this review target is ambiguous.`,
      },
      400,
    );
  }

  const repositoryRow = repositoryRows[0]!;
  const provider = repositoryRow.sourceControlProvider as
    | FastAgentSourceControlSurface
    | string;
  if (
    !SOURCE_CONTROL_PROVIDERS.includes(
      provider as FastAgentSourceControlSurface,
    )
  ) {
    return c.json({ error: 'Unsupported source control provider.' }, 400);
  }
  const host =
    repositoryRow.host ??
    sourceControlProviderDescriptors[provider as FastAgentSourceControlSurface]
      .defaultHost;

  // Imported lazily: @roomote/sdk/server evaluates db schema at import time,
  // which breaks narrowly mocked handler tests that import this module.
  const { buildSourceControlFastConversation, buildSourceControlFastDelivery } =
    await import('@roomote/sdk/server');

  const conversation = buildSourceControlFastConversation({
    provider: provider as FastAgentSourceControlSurface,
    host,
    repositoryFullName,
    kind: 'pull',
    number: prNumber,
  });
  const delivery = await buildSourceControlFastDelivery(conversation);
  if (!delivery) {
    return c.json(
      { error: `Repository "${repositoryFullName}" is not connected.` },
      404,
    );
  }

  const target = await delivery.resolveTarget();
  const pullRequest = target.pullRequest;
  if (!pullRequest?.sha) {
    return c.json(
      {
        error: `Pull request #${prNumber} in ${repositoryFullName} could not be resolved.`,
      },
      404,
    );
  }

  let parent: FastAgentParent | null = null;
  if (body.fastConversationId) {
    const record = await fastAgentConversationRepository.findById({
      id: body.fastConversationId,
    });
    if (!record) {
      return c.json({ error: 'The requesting Session was not found.' }, 404);
    }
    parent = { sessionId: record.id, conversation: record.conversation };
  }

  const payload: TaskPayload<typeof TaskPayloadKind.GithubPrReview> = {
    repo: repositoryFullName,
    sourceControlProvider: provider as FastAgentSourceControlSurface,
    ...(repositoryRow.host ? { sourceControlHost: repositoryRow.host } : {}),
    prNumber,
    prTitle: pullRequest.title ?? `${repositoryFullName}#${prNumber}`,
    prUrl: pullRequest.url,
    headSha: pullRequest.sha,
    ...(target.branch ? { branchName: target.branch } : {}),
    ...(parent
      ? {
          ...buildFastAgentSessionAttachment(parent),
          fastParentRequestedReview: true,
        }
      : {}),
  };

  const launch = await enqueueTask({
    task: { type: TaskPayloadKind.GithubPrReview, payload },
    initiator: { kind: 'user', userId: auth.userId },
    workflow: 'pr_review',
    surface: provider as FastAgentSourceControlSurface,
    trigger: 'manual',
    prLinkage: {
      provider: provider as FastAgentSourceControlSurface,
      host,
      repositoryId: repositoryRow.id,
      repository: repositoryFullName,
      prNumber,
      prUrl: pullRequest.url,
      prTitle: pullRequest.title ?? null,
      prSha: pullRequest.sha,
    },
  });

  return c.json({
    success: true,
    taskId: launch.taskId,
    runId: launch.id,
    taskUrl: getTaskUrl({
      taskId: launch.taskId,
      utm: { source: 'fast', campaign: 'fast.pr_review' },
    }),
    prUrl: pullRequest.url,
    ...(pullRequest.title ? { prTitle: pullRequest.title } : {}),
  });
}
