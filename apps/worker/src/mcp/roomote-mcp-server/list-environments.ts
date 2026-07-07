import { ALL_REPOSITORIES } from '@roomote/types';

import { listEnvironments } from './tasks-api-client.js';
import { textResult, catchError } from './tool-result.js';
import type { RoomoteConfig, ToolResult } from './types.js';

export async function handleListEnvironments(
  config: RoomoteConfig,
): Promise<ToolResult> {
  try {
    const result = await listEnvironments(config);

    return textResult(
      JSON.stringify(
        {
          instructions:
            'Call "launch" with one of these environmentId values. Do not invent or guess an environmentId.',
          environments: [
            {
              environmentId: ALL_REPOSITORIES,
              name: 'All repositories',
              description:
                'Pass this environmentId to "launch" to run the task against all repositories',
            },
            ...result.environments.map((environment) => ({
              environmentId: environment.id,
              name: environment.name,
              description:
                environment.description ??
                `Pass this environmentId to "launch" to run the task against the "${environment.name}" environment`,
            })),
          ],
        },
        null,
        2,
      ),
    );
  } catch (error) {
    return catchError(error);
  }
}
