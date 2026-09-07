import {
  resolveComputeProviderSelection,
  resolveDefaultComputeProvider,
} from '@roomote/db/server';

import type { TaskLaunchConfig } from '@/components/tasks/TaskLaunchConfig';
import { bootstrapWebRuntimeEnv } from '@/lib/server/bootstrap-runtime-env';
import { Env, isRoomoteCloudEnabled } from '@/lib/server/env';

export async function resolveTaskLaunchConfig(): Promise<TaskLaunchConfig> {
  await bootstrapWebRuntimeEnv();

  if (isRoomoteCloudEnabled(Env.R_CLOUD_ENABLED)) {
    const defaultComputeProvider = await resolveDefaultComputeProvider();

    return {
      defaultComputeProvider,
      availableComputeProviders: [defaultComputeProvider],
    };
  }

  return resolveComputeProviderSelection();
}
