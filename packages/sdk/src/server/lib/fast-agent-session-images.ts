import { basename } from 'node:path';

import { and, db, inArray, taskArtifacts, taskRuns } from '@roomote/db/server';
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
  if (runIds.length > 0) {
    const lookupIds = await fastAgentConversationRepository.getLookupIds(
      params.sessionId,
    );
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
    if (
      !artifact ||
      !artifact.uploaded ||
      artifact.runId === null ||
      artifact.taskId !== sessionRunTaskById.get(artifact.runId) ||
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
