import type { UserAuthSuccess } from '@/types';
import { getArtifactVersionsByPath } from '@/lib/server';

export async function getArtifactVersionsCommand(
  auth: UserAuthSuccess,
  input: { taskId: string; path: string },
): Promise<
  {
    id: string;
    version: number;
    size: number;
    createdAt: Date;
  }[]
> {
  return getArtifactVersionsByPath({
    taskId: input.taskId,
    path: input.path,
    auth: { userId: auth.userId, isAdmin: auth.isAdmin },
  });
}
