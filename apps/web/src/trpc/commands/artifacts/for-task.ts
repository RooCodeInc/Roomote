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
      const { privacy, ...publicArtifact } = artifact;
      const isImage = artifact.contentType.startsWith('image/');
      const authenticatedRawUrl = `/api/artifacts/${artifact.id}/raw?sig=${signArtifactId(artifact.id, ts)}&ts=${ts}`;
      const thumbnailUrl = isImage ? authenticatedRawUrl : undefined;

      const isVideo =
        artifact.contentType.startsWith('video/') ||
        artifact.path.toLowerCase().endsWith('.webm');
      const previewUrl = isVideo
        ? privacy === 'private'
          ? authenticatedRawUrl
          : await generateDownloadUrl(
              input.taskId,
              artifact.id,
              artifact.path,
              artifact.version,
            )
        : undefined;

      return { ...publicArtifact, thumbnailUrl, previewUrl };
    }),
  );
}
