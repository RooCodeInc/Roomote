import { getFastAgentParentFromPayload } from '@roomote/types';
import {
  and,
  db,
  eq,
  recordTaskRunLifecycleEvent,
  slackInstallations,
  slackQuickAnswers,
  sql,
  taskRuns,
} from '@roomote/db/server';
import { Env } from '@roomote/env';
import { SlackNotifier } from '@roomote/slack';

export type FastArtifactNotificationResult =
  | 'not_applicable'
  | 'already_delivered'
  | 'delivered'
  | 'failed';

function escapeSlackText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function buildArtifactViewUrl(input: {
  taskId: string;
  path: string;
  version: number;
}): string {
  const baseUrl = (Env.R_PUBLIC_URL ?? Env.R_APP_URL).replace(/\/+$/, '');
  const encodedPath = input.path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `${baseUrl}/task/${encodeURIComponent(input.taskId)}/artifacts/${encodedPath}?v=${input.version}`;
}

/** Relay one uploaded artifact version through its runless Fast parent. */
export async function notifyFastAgentParentOnArtifact(input: {
  id: string;
  taskId: string;
  runId: number | null;
  path: string;
  version: number;
  uploaded: boolean;
}): Promise<FastArtifactNotificationResult> {
  if (!input.runId || !input.uploaded) {
    return 'not_applicable';
  }

  const run = await db.query.taskRuns.findFirst({
    where: and(eq(taskRuns.id, input.runId), eq(taskRuns.taskId, input.taskId)),
    columns: { id: true, taskId: true, payload: true, result: true },
  });
  const parent = getFastAgentParentFromPayload(run?.payload);
  if (!run || !parent) {
    return 'not_applicable';
  }

  const deliveryKey = `fastAgentArtifact:${input.id}`;
  try {
    if (
      (run.result as Record<string, unknown> | null)?.[deliveryKey] ===
      'delivered'
    ) {
      return 'already_delivered';
    }

    const scopedChannel = `${parent.slackTeamId}:${parent.slackChannel}`;
    const [session, installation] = await Promise.all([
      db.query.slackQuickAnswers.findFirst({
        where: and(
          eq(slackQuickAnswers.id, parent.sessionId),
          eq(slackQuickAnswers.slackChannel, scopedChannel),
          eq(slackQuickAnswers.slackThreadTs, parent.slackThreadTs),
        ),
        columns: { id: true },
      }),
      db.query.slackInstallations.findFirst({
        where: and(
          eq(slackInstallations.isActive, true),
          eq(slackInstallations.teamId, parent.slackTeamId),
        ),
        columns: { botAccessToken: true },
      }),
    ]);

    if (!session || !installation?.botAccessToken) {
      return 'failed';
    }

    const viewUrl = buildArtifactViewUrl(input);
    const path = escapeSlackText(input.path);
    const slackMessage = `The delegated task published artifact ${path} (version ${input.version}). <${viewUrl}|View artifact>`;
    const sessionMessage = `The delegated task published artifact ${input.path} (version ${input.version}). [View artifact](${viewUrl})`;
    const messageTs = await new SlackNotifier(
      installation.botAccessToken,
    ).postMessage({
      channel: parent.slackChannel,
      thread_ts: parent.slackThreadTs,
      text: slackMessage,
      client_msg_id: input.id,
      unfurl_links: false,
      unfurl_media: false,
    });
    if (!messageTs) {
      throw new Error('Slack did not return an artifact message timestamp.');
    }
    const recorded = await db.transaction(async (tx) => {
      const deliveredRows = await tx
        .update(taskRuns)
        .set({
          result: sql`coalesce(${taskRuns.result}, '{}'::jsonb) || jsonb_build_object(${deliveryKey}::text, 'delivered'::text)`,
        })
        .where(
          and(
            eq(taskRuns.id, run.id),
            sql`(${taskRuns.result} -> ${deliveryKey}) is null`,
          ),
        )
        .returning({ id: taskRuns.id });

      if (deliveredRows.length === 0) {
        return false;
      }

      await tx
        .update(slackQuickAnswers)
        .set({
          messages: sql`${slackQuickAnswers.messages} || ${JSON.stringify([
            { role: 'assistant', content: sessionMessage },
          ])}::jsonb`,
          updatedAt: sql`now()`,
        })
        .where(eq(slackQuickAnswers.id, parent.sessionId));

      await recordTaskRunLifecycleEvent(tx, {
        runId: run.id,
        taskId: run.taskId,
        eventType: 'decision',
        message: `Delivered artifact ${input.id} version ${input.version} through the Fast parent.`,
        details: {
          reason: 'fast_agent_parent_artifact_notification',
          artifactId: input.id,
          artifactPath: input.path,
          artifactVersion: input.version,
          fastAgentSessionId: parent.sessionId,
        },
      });

      return true;
    });

    if (!recorded) {
      return 'already_delivered';
    }

    return 'delivered';
  } catch (error) {
    console.error(
      `[notifyFastAgentParentOnArtifact] Failed for artifact ${input.id}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return 'failed';
  }
}
