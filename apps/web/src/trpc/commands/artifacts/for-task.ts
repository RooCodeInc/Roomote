import type { TaskArtifact } from '@/types';
import type { UserAuthSuccess } from '@/types';
import {
  getArtifactsForTask,
  generateDownloadUrl,
  signArtifactId,
  currentEpochSeconds,
} from '@/lib/server';

export async function getArtifactsForTaskCommand(
  auth: UserAuthSuccess,
  input: { taskId: string },
): Promise<TaskArtifact[]> {
  const artifacts = await getArtifactsForTask({
    taskId: input.taskId,
    auth: { userId: auth.userId, isAdmin: auth.isAdmin },
  });

  const ts = currentEpochSeconds();

  return Promise.all(
    artifacts.map(async (artifact) => {
      const isImage = artifact.contentType.startsWith('image/');
      const thumbnailUrl = isImage
        ? `/api/artifacts/${artifact.id}/raw?sig=${signArtifactId(artifact.id, ts)}&ts=${ts}`
        : undefined;

      const isVideo =
        artifact.contentType.startsWith('video/') ||
        artifact.path.toLowerCase().endsWith('.webm');
      const previewUrl = isVideo
        ? await generateDownloadUrl(
            input.taskId,
            artifact.id,
            artifact.path,
            artifact.version,
          )
        : undefined;

      return { ...artifact, thumbnailUrl, previewUrl };
    }),
  );
}
