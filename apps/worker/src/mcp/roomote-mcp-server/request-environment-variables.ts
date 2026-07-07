import {
  createTaskEnvVarRequestSchema,
  type CreateTaskEnvVarRequestInput,
} from '@roomote/types';

import { catchError, successResult } from './tool-result.js';
import type { ToolResult } from './types.js';

export async function handleRequestEnvironmentVariables(
  params: CreateTaskEnvVarRequestInput,
  options?: {
    taskId?: string | null;
  },
): Promise<ToolResult> {
  try {
    const parsed = createTaskEnvVarRequestSchema.parse(params);
    const requestedNames = parsed.variables.map((item) => item.name);

    return successResult({
      requestCreated: true,
      requestedNames,
      taskStopRequested: Boolean(options?.taskId),
    });
  } catch (error) {
    return catchError(error);
  }
}
