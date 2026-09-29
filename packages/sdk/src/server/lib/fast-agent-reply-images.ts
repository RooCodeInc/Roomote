import { basename } from 'node:path';

import { db, inArray, taskArtifacts } from '@roomote/db/server';
import { Env, getArtifactSigningKey } from '@roomote/env';

import type { FastAgentReplyImage } from './fast-agent-session-images';
import {
  buildSignedArtifactRawUrl,
  currentEpochSeconds,
} from './artifacts/raw-url';

export async function resolveFastAgentReplyImages(params: {
  artifactIds: string[];
}): Promise<FastAgentReplyImage[]> {
  const artifactIds = [...new Set(params.artifactIds)];
  if (artifactIds.length === 0) return [];

  const artifacts = await db.query.taskArtifacts.findMany({
    where: inArray(taskArtifacts.id, artifactIds),
    columns: {
      id: true,
      path: true,
      contentType: true,
      uploaded: true,
    },
  });
  const byId = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  const ts = currentEpochSeconds();
  return artifactIds.flatMap((id) => {
    const artifact = byId.get(id);
    if (
      !artifact ||
      !artifact.uploaded ||
      !artifact.contentType.startsWith('image/')
    ) {
      return [];
    }
    return [
      {
        url: buildSignedArtifactRawUrl({
          artifactId: artifact.id,
          ts,
          apiBaseUrl: Env.R_APP_URL,
          signingKey: getArtifactSigningKey(),
        }),
        altText: basename(artifact.path) || 'Task artifact',
        contentType: artifact.contentType,
      },
    ];
  });
}
