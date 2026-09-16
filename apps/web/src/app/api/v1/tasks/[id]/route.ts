import {
  currentEpochSeconds,
  signArtifactId,
} from '@/lib/server/artifact-signature';
import { ApiV1Error, jsonOk, withApiV1Auth } from '@/lib/server/api-v1';
import { getTaskByIdCommand } from '@/trpc/commands/tasks';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Bucket signatures so a polling client gets byte-stable URLs for an hour. */
const ARTIFACT_SIGNATURE_CACHE_WINDOW_SECONDS = 60 * 60;

/**
 * Task detail with its artifacts. Each artifact carries a short-lived signed
 * `url` for the raw bytes, the same signature the web transcript uses, so the
 * app can load images and videos with a plain URL request.
 */
export const GET = withApiV1Auth<{ id: string }>(async ({ auth, params }) => {
  const task = await getTaskByIdCommand(auth, {
    taskId: params.id,
    includeArtifacts: true,
  });
  if (!task) throw new ApiV1Error('Task not found', 404);

  const signatureTs =
    Math.floor(
      currentEpochSeconds() / ARTIFACT_SIGNATURE_CACHE_WINDOW_SECONDS,
    ) * ARTIFACT_SIGNATURE_CACHE_WINDOW_SECONDS;
  const artifacts = (task.artifacts ?? []).map((artifact) => ({
    ...artifact,
    url: `/api/artifacts/${artifact.id}/raw?sig=${signArtifactId(artifact.id, signatureTs)}&ts=${signatureTs}`,
  }));

  return jsonOk({ ...task, artifacts });
});
