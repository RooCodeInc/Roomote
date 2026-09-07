import {
  slackInstallations,
  sql,
  taskRuns,
  trackedMessages,
} from '@roomote/db/server';

/**
 * Slack thread timestamps are workspace-local. Modern runs must match their
 * payload workspace. A payload-less legacy run is eligible only while the
 * incoming team is the deployment's sole active Slack installation; keeping
 * that proof inside the query prevents an installation change racing lookup.
 */
export function getSlackTaskRunWorkspacePredicate(slackTeamId: string) {
  const payloadTeamId = sql`COALESCE(NULLIF(${taskRuns.payload}->>'teamId', ''), NULLIF(${taskRuns.payload}->>'slackTeamId', ''))`;

  return sql`(
    ${payloadTeamId} = ${slackTeamId}
    OR (
      ${payloadTeamId} IS NULL
      AND (
        SELECT count(*)
        FROM ${slackInstallations}
        WHERE ${slackInstallations.isActive} = true
      ) = 1
      AND EXISTS (
        SELECT 1
        FROM ${slackInstallations}
        WHERE ${slackInstallations.isActive} = true
          AND ${slackInstallations.teamId} = ${slackTeamId}
      )
    )
  )`;
}

export function getSlackTrackedAliasTaskPredicate(params: {
  taskId: string;
  slackTeamId: string;
  channelId: string;
  threadTs: string;
}) {
  return sql`EXISTS (
    SELECT 1
    FROM ${trackedMessages}
    WHERE ${trackedMessages.surface} = 'slack'
      AND ${trackedMessages.kind} = 'automation_thread'
      AND ${trackedMessages.channelId} = ${params.channelId}
      AND ${trackedMessages.threadTs} = ${params.threadTs}
      AND ${trackedMessages.metadata}->>'sourceTaskId' = ${params.taskId}
      AND ${trackedMessages.metadata}->>'slackTeamId' = ${params.slackTeamId}
  )`;
}
