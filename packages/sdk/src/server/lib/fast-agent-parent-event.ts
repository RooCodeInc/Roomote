import { createHash } from 'node:crypto';
import { basename } from 'node:path';

import {
  acquireFastAgentTurnLock,
  answerFastAgentQuestion,
} from '@roomote/cloud-agents/server';
import {
  and,
  db,
  eq,
  inArray,
  slackInstallations,
  slackQuickAnswers,
  taskArtifacts,
} from '@roomote/db/server';
import { Env, getArtifactSigningKey } from '@roomote/env';
import { SlackNotifier } from '@roomote/slack';
import type { FastAgentParent, SlackBlock } from '@roomote/types';

import {
  buildSignedArtifactRawUrl,
  currentEpochSeconds,
} from './artifacts/raw-url';

/** Deterministic uuid-shaped Slack client_msg_id so a retried delivery of the
 * same event posts with the same idempotency key instead of duplicating. */
export function buildSlackClientMessageId(seed: string): string {
  const hash = createHash('sha256').update(seed).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

export class FastAgentParentEventDeliveryError extends Error {
  /** True once the orchestrator's reply reached Slack; callers must not
   * release their delivery claim in that case or a retry double-posts. */
  readonly slackPosted: boolean;
  /** True when no retry can ever succeed (parent session or Slack
   * installation is gone); callers should stop retrying. */
  readonly permanent: boolean;

  constructor(
    message: string,
    options: { cause?: unknown; slackPosted: boolean; permanent?: boolean },
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : {});
    this.name = 'FastAgentParentEventDeliveryError';
    this.slackPosted = options.slackPosted;
    this.permanent = options.permanent ?? false;
  }
}

type FastAgentParentEvent =
  | {
      type: 'artifact_published';
      taskId: string;
      runId: number;
      artifact: {
        id: string;
        path: string;
        version: number;
        contentType: string;
        viewUrl: string;
      };
    }
  | {
      type: 'task_settled';
      taskId: string;
      runId: number;
      title?: string;
      status: string;
      taskUrl: string;
    };

async function buildSelectedImageBlocks(params: {
  artifactIds: string[];
  event: FastAgentParentEvent;
}): Promise<SlackBlock[]> {
  const artifactIds = [...new Set(params.artifactIds)];
  if (params.event.type !== 'artifact_published' || artifactIds.length === 0) {
    return [];
  }

  const allowedId = params.event.artifact.id;
  if (artifactIds.some((id) => id !== allowedId)) {
    throw new Error('Fast parent selected an artifact outside this event.');
  }

  const artifacts = await db.query.taskArtifacts.findMany({
    where: inArray(taskArtifacts.id, artifactIds),
    columns: {
      id: true,
      taskId: true,
      runId: true,
      path: true,
      contentType: true,
      uploaded: true,
    },
  });
  const byId = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  const ts = currentEpochSeconds();

  return artifactIds.map((id) => {
    const artifact = byId.get(id);
    if (
      !artifact ||
      !artifact.uploaded ||
      artifact.taskId !== params.event.taskId ||
      artifact.runId !== params.event.runId ||
      !artifact.contentType.startsWith('image/')
    ) {
      throw new Error(`Invalid Fast parent image artifact: ${id}`);
    }

    return {
      type: 'image' as const,
      image_url: buildSignedArtifactRawUrl({
        artifactId: artifact.id,
        ts,
        apiBaseUrl: Env.R_APP_URL,
        signingKey: getArtifactSigningKey(),
      }),
      alt_text: basename(artifact.path) || 'Task artifact',
    };
  });
}

function buildEventClientMessageSeed(event: FastAgentParentEvent): string {
  return event.type === 'artifact_published'
    ? `fast-parent-artifact:${event.artifact.id}:v${event.artifact.version}`
    : `fast-parent-settle:${event.runId}`;
}

/** Give a structured child event to the Fast orchestrator for presentation. */
export async function deliverFastAgentParentEvent(params: {
  parent: FastAgentParent;
  event: FastAgentParentEvent;
  /** Cap the turn-lock wait so callers holding an HTTP request can fail fast
   * and lean on their own retry instead of blocking. */
  lockWaitMs?: number;
}): Promise<void> {
  const releaseTurnLock = await acquireFastAgentTurnLock({
    slackTeamId: params.parent.slackTeamId,
    slackChannel: params.parent.slackChannel,
    slackThreadTs: params.parent.slackThreadTs,
    ...(params.lockWaitMs !== undefined
      ? { maxWaitMs: params.lockWaitMs }
      : {}),
  });
  if (!releaseTurnLock) {
    throw new FastAgentParentEventDeliveryError(
      'Fast parent turn lock did not become available.',
      { slackPosted: false },
    );
  }

  let slackPosted = false;

  try {
    const scopedChannel = `${params.parent.slackTeamId}:${params.parent.slackChannel}`;
    const [session, installation] = await Promise.all([
      db.query.slackQuickAnswers.findFirst({
        where: and(
          eq(slackQuickAnswers.id, params.parent.sessionId),
          eq(slackQuickAnswers.slackChannel, scopedChannel),
          eq(slackQuickAnswers.slackThreadTs, params.parent.slackThreadTs),
        ),
        columns: { id: true, userId: true },
      }),
      db.query.slackInstallations.findFirst({
        where: and(
          eq(slackInstallations.isActive, true),
          eq(slackInstallations.teamId, params.parent.slackTeamId),
        ),
        columns: { botAccessToken: true },
      }),
    ]);

    if (!session || !installation?.botAccessToken) {
      throw new FastAgentParentEventDeliveryError(
        'Fast parent session or Slack installation was not found.',
        { slackPosted: false, permanent: true },
      );
    }

    const slack = new SlackNotifier(installation.botAccessToken);
    await answerFastAgentQuestion({
      question: `<delegated_task_event>${JSON.stringify(params.event)}</delegated_task_event>`,
      userId: session.userId,
      slackTeamId: params.parent.slackTeamId,
      slackChannel: params.parent.slackChannel,
      slackThreadTs: params.parent.slackThreadTs,
      activeTaskId:
        params.event.type === 'artifact_published' ? params.event.taskId : null,
      platformEvent: true,
      postSlackReply: async ({ message, imageArtifactIds = [] }) => {
        const imageBlocks = await buildSelectedImageBlocks({
          artifactIds: imageArtifactIds,
          event: params.event,
        });
        const messageTs = await slack.postMessage({
          channel: params.parent.slackChannel,
          thread_ts: params.parent.slackThreadTs,
          text: message,
          blocks: [{ type: 'markdown', text: message }, ...imageBlocks],
          unfurl_links: false,
          unfurl_media: false,
          client_msg_id: buildSlackClientMessageId(
            buildEventClientMessageSeed(params.event),
          ),
        });
        if (!messageTs) {
          throw new Error(
            'Slack did not return a Fast parent event timestamp.',
          );
        }
        slackPosted = true;
      },
    });
  } catch (error) {
    if (error instanceof FastAgentParentEventDeliveryError) {
      throw error;
    }
    throw new FastAgentParentEventDeliveryError(
      error instanceof Error ? error.message : String(error),
      { cause: error, slackPosted },
    );
  } finally {
    await releaseTurnLock();
  }
}
