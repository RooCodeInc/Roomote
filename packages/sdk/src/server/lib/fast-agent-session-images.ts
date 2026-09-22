import { basename } from 'node:path';

import {
  and,
  db,
  inArray,
  sessions,
  taskArtifacts,
  taskRuns,
} from '@roomote/db/server';
import { Env, getArtifactSigningKey } from '@roomote/env';

import { fastAgentConversationRepository } from '@roomote/cloud-agents/server';

import {
  buildSignedArtifactRawUrl,
  currentEpochSeconds,
} from './artifacts/raw-url';

export type FastAgentReplyImage = {
  url: string;
  altText: string;
  contentType: string;
};

export async function resolveFastAgentSessionImages(params: {
  artifactIds: string[];
  sessionId: string;
}): Promise<FastAgentReplyImage[]> {
  const artifactIds = [...new Set(params.artifactIds)];
  if (artifactIds.length === 0) return [];

  const artifacts = await db.query.taskArtifacts.findMany({
    where: inArray(taskArtifacts.id, artifactIds),
    columns: {
      id: true,
      taskId: true,
      sessionId: true,
      runId: true,
      path: true,
      contentType: true,
      uploaded: true,
    },
  });
  const runIds = artifacts.flatMap((artifact) =>
    artifact.runId === null ? [] : [artifact.runId],
  );
  const sessionRunTaskById = new Map<number, string>();
  const lookupIds = await fastAgentConversationRepository.getLookupIds(
    params.sessionId,
  );
  // Session-owned artifacts (the `browse` tool's captures) are owned by the
  // unified `sessions` row, not the Fast conversation id, so map every
  // lookup id to its Session before comparing.
  const ownedSessionIds = new Set<string>(
    (
      await db.query.sessions.findMany({
        where: inArray(sessions.fastConversationId, lookupIds),
        columns: { id: true },
      })
    ).map((session) => session.id),
  );
  if (runIds.length > 0) {
    const sessionRuns = await db.query.taskRuns.findMany({
      where: and(
        inArray(taskRuns.id, runIds),
        inArray(taskRuns.fastAgentSessionId, lookupIds),
      ),
      columns: { id: true, taskId: true },
    });
    for (const run of sessionRuns) {
      sessionRunTaskById.set(run.id, run.taskId);
    }
  }

  const byId = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  const ts = currentEpochSeconds();
  return artifactIds.map((id) => {
    const artifact = byId.get(id);
    const ownedByRun =
      artifact?.runId !== null &&
      artifact?.runId !== undefined &&
      artifact.taskId === sessionRunTaskById.get(artifact.runId);
    const ownedBySession =
      artifact?.sessionId !== null &&
      artifact?.sessionId !== undefined &&
      ownedSessionIds.has(artifact.sessionId);
    if (
      !artifact ||
      !artifact.uploaded ||
      !(ownedByRun || ownedBySession) ||
      !artifact.contentType.startsWith('image/')
    ) {
      throw new Error(`Invalid Fast parent image artifact: ${id}`);
    }
    return {
      url: buildSignedArtifactRawUrl({
        artifactId: artifact.id,
        ts,
        apiBaseUrl: Env.R_APP_URL,
        signingKey: getArtifactSigningKey(),
      }),
      altText: basename(artifact.path) || 'Task artifact',
      contentType: artifact.contentType,
    };
  });
}
