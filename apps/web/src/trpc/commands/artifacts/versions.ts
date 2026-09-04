import type { UserAuthSuccess } from '@/types';
import {
  getArtifactVersionsByPath,
  getArtifactVersionsBySessionPath,
} from '@/lib/server';
import { findAccessibleSession } from '@/lib/server/sessions';

export async function getArtifactVersionsCommand(
  auth: UserAuthSuccess,
  input: { taskId?: string; sessionId?: string; path: string },
): Promise<
  {
    id: string;
    version: number;
    size: number;
    createdAt: Date;
  }[]
> {
  const artifactAuth = { userId: auth.userId, isAdmin: auth.isAdmin };
  if (
    input.sessionId &&
    !(await findAccessibleSession(artifactAuth, input.sessionId))
  ) {
    return [];
  }
  return input.taskId
    ? getArtifactVersionsByPath({
        taskId: input.taskId,
        path: input.path,
        auth: artifactAuth,
      })
    : getArtifactVersionsBySessionPath({
        sessionId: input.sessionId!,
        path: input.path,
        auth: artifactAuth,
      });
}
