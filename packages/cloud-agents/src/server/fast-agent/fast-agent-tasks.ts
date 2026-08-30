import { tool, type ToolSet } from 'ai';
import { createAuthToken } from '@roomote/auth';
import { ALL_REPOSITORIES } from '@roomote/types';
import { z } from 'zod';

import { resolveApiBaseUrl } from '../shared-utils';
import {
  FAST_AGENT_ENVIRONMENTS_API_PATH,
  FAST_AGENT_TASKS_API_PATH,
} from './fast-agent-constants';

type FastAgentTaskToolResult = Record<string, unknown>;

type ResolveFastAgentAuthToken = () => Promise<string>;

export interface FastAgentTaskApiContext {
  apiBaseUrl?: string;
  getAuthToken?: ResolveFastAgentAuthToken;
  userId: string;
}

type ListEnvironmentsResponse = {
  environments?: Array<{
    id: string;
    name: string;
    description?: string | null;
    repositories?: Array<{
      id: string | number;
      fullName: string;
    }>;
  }>;
} & FastAgentTaskToolResult;

async function resolveFastAgentTaskAuthContext({
  userId,
  apiBaseUrl,
  getAuthToken,
}: FastAgentTaskApiContext): Promise<
  | {
      authToken: string;
      resolvedApiBaseUrl: string;
    }
  | {
      error: string;
    }
> {
  const resolvedApiBaseUrl = resolveApiBaseUrl(apiBaseUrl);
  if (!resolvedApiBaseUrl) {
    return { error: 'Task API base URL is unavailable.' };
  }

  try {
    const authToken =
      (await getAuthToken?.()) ??
      (await createAuthToken({
        userId,
        timeoutMs: 2 * 60_000,
      }));

    return {
      authToken,
      resolvedApiBaseUrl,
    };
  } catch (error) {
    return {
      error:
        error instanceof Error
          ? error.message
          : 'Failed to create an auth token for the task API.',
    };
  }
}

function buildFastAgentTaskApiUrl({
  resolvedApiBaseUrl,
  path,
  query,
}: {
  resolvedApiBaseUrl: string;
  path: string;
  query?: Record<string, string | number | undefined>;
}): string {
  const relativePath = path.replace(/^\/+/, '');
  const url = new URL(relativePath, `${resolvedApiBaseUrl}/`);

  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === '') {
      continue;
    }

    url.searchParams.set(key, String(value));
  }

  return url.toString();
}

async function parseFastAgentTaskApiResponse(
  response: Response,
): Promise<FastAgentTaskToolResult> {
  try {
    const body = (await response.json()) as FastAgentTaskToolResult;
    if (body && typeof body === 'object') {
      return body;
    }
  } catch {
    // Fall through to the generic error payload below.
  }

  return {
    success: false,
    error: response.ok
      ? 'Task API returned an unexpected response.'
      : `Task API request failed with status ${response.status}.`,
  };
}

function withAllRepositoriesLaunchTarget(
  result: FastAgentTaskToolResult,
): FastAgentTaskToolResult {
  const environments = (result as ListEnvironmentsResponse).environments;
  if (!Array.isArray(environments)) {
    return result;
  }

  return {
    ...result,
    environments: [
      {
        id: ALL_REPOSITORIES,
        name: 'All repositories',
        description:
          'Use this target to run the task against all active repositories.',
        repositories: [],
      },
      ...environments.filter(
        (environment) => environment.id !== ALL_REPOSITORIES,
      ),
    ],
  };
}

async function callFastAgentTaskApi({
  method,
  path,
  query,
  body,
  ...context
}: FastAgentTaskApiContext & {
  method: 'GET' | 'POST';
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: Record<string, unknown>;
}): Promise<FastAgentTaskToolResult> {
  const authContext = await resolveFastAgentTaskAuthContext(context);
  if ('error' in authContext) {
    return {
      success: false,
      error: authContext.error,
    };
  }

  try {
    const response = await fetch(
      buildFastAgentTaskApiUrl({
        resolvedApiBaseUrl: authContext.resolvedApiBaseUrl,
        path,
        query,
      }),
      {
        method,
        headers: {
          Authorization: `Bearer ${authContext.authToken}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
    );

    return await parseFastAgentTaskApiResponse(response);
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error ? error.message : 'Failed to call the task API.',
    };
  }
}

export async function sendFastAgentTaskMessage(
  context: FastAgentTaskApiContext,
  params: { taskId: string; message: string; images?: string[] },
): Promise<FastAgentTaskToolResult> {
  return callFastAgentTaskApi({
    ...context,
    method: 'POST',
    path: `${FAST_AGENT_TASKS_API_PATH}/${params.taskId}/steer_message`,
    body: {
      message: params.message,
      ...(params.images?.length ? { images: params.images } : {}),
      senderMode: 'fast_agent',
    },
  });
}

export async function sendFastAgentTaskMessageOnce(
  context: FastAgentTaskApiContext,
  params: {
    taskId: string;
    message: string;
    clientMessageId: string;
  },
): Promise<FastAgentTaskToolResult> {
  return callFastAgentTaskApi({
    ...context,
    method: 'POST',
    path: `${FAST_AGENT_TASKS_API_PATH}/${params.taskId}/send_message`,
    body: {
      message: params.message,
      clientMessageId: params.clientMessageId,
    },
  });
}

export async function cancelFastAgentTask(
  context: FastAgentTaskApiContext,
  taskId: string,
): Promise<FastAgentTaskToolResult> {
  return callFastAgentTaskApi({
    ...context,
    method: 'POST',
    path: `${FAST_AGENT_TASKS_API_PATH}/${taskId}/cancel`,
  });
}

const fastAgentTaskStatusSchema = z.enum(['active', 'completed', 'all']);
const fastAgentTaskOrderSchema = z.enum(['asc', 'desc']);
const fastAgentTaskTypeSchema = z.enum(['standard']);
const nonEmptyTrimmedStringSchema = z
  .string()
  .trim()
  .refine((value) => value.length > 0, {
    message: 'Value must be non-empty.',
  });

export function createFastAgentTaskTools(
  context: FastAgentTaskApiContext,
): ToolSet {
  return {
    list_environments: tool({
      description: 'List environments available for launching Roomote tasks.',
      inputSchema: z.object({}).strict(),
      execute: async () =>
        withAllRepositoriesLaunchTarget(
          await callFastAgentTaskApi({
            ...context,
            method: 'GET',
            path: FAST_AGENT_ENVIRONMENTS_API_PATH,
          }),
        ),
    }),
    launch_task: tool({
      description:
        'Launch a new Roomote coding task in a specific environment.',
      inputSchema: z
        .object({
          prompt: nonEmptyTrimmedStringSchema.describe(
            'The non-empty coding request or task description',
          ),
          environmentId: nonEmptyTrimmedStringSchema
            .optional()
            .describe(
              'Optional non-empty environment ID. Omit it or pass "__all_repositories__" to use the deployment-wide default target',
            ),
          type: fastAgentTaskTypeSchema
            .optional()
            .describe('Optional task type override'),
          model: nonEmptyTrimmedStringSchema
            .optional()
            .describe(
              'Optional exact deployment-enabled model ID. Omit it to use the deployment default',
            ),
        })
        .strict(),
      execute: async ({ prompt, environmentId, type, model }) =>
        callFastAgentTaskApi({
          ...context,
          method: 'POST',
          path: FAST_AGENT_TASKS_API_PATH,
          body: {
            prompt,
            repo: ALL_REPOSITORIES,
            ...(environmentId && environmentId !== ALL_REPOSITORIES
              ? { environmentId }
              : {}),
            ...(type ? { type } : {}),
            ...(model ? { model } : {}),
          },
        }),
    }),
    search_tasks: tool({
      description: 'Search Roomote tasks by text or status.',
      inputSchema: z
        .object({
          query: nonEmptyTrimmedStringSchema
            .optional()
            .describe(
              'Optional non-empty text to match against task titles and prompts',
            ),
          status: fastAgentTaskStatusSchema
            .optional()
            .describe('Optional task-status filter'),
          limit: z
            .number()
            .int()
            .refine((value) => value >= 1 && value <= 100, {
              message: 'Limit must be between 1 and 100.',
            })
            .optional()
            .describe('Maximum number of tasks to return, from 1 to 100'),
        })
        .strict(),
      execute: async ({ query, status, limit }) =>
        callFastAgentTaskApi({
          ...context,
          method: 'GET',
          path: FAST_AGENT_TASKS_API_PATH,
          query: {
            query,
            status,
            limit,
          },
        }),
    }),
    get_task_messages: tool({
      description: 'Get the message history for a Roomote task.',
      inputSchema: z
        .object({
          taskId: nonEmptyTrimmedStringSchema.describe(
            'The non-empty Roomote task ID',
          ),
          limit: z
            .number()
            .int()
            .refine((value) => value >= 1 && value <= 1000, {
              message: 'Limit must be between 1 and 1,000.',
            })
            .optional()
            .describe('Maximum number of messages to return, from 1 to 1,000'),
          order: fastAgentTaskOrderSchema
            .optional()
            .describe('Message order: oldest first or newest first'),
        })
        .strict(),
      execute: async ({ taskId, limit, order }) =>
        callFastAgentTaskApi({
          ...context,
          method: 'GET',
          path: `${FAST_AGENT_TASKS_API_PATH}/${taskId}/messages`,
          query: {
            limit,
            order,
          },
        }),
    }),
    send_task_message: tool({
      description:
        'Send a follow-up message to an active or resumable Roomote task.',
      inputSchema: z
        .object({
          taskId: nonEmptyTrimmedStringSchema.describe(
            'The non-empty Roomote task ID',
          ),
          message: nonEmptyTrimmedStringSchema.describe(
            'The non-empty follow-up message to send',
          ),
        })
        .strict(),
      execute: async ({ taskId, message }) =>
        sendFastAgentTaskMessage(context, { taskId, message }),
    }),
    cancel_task: tool({
      description: 'Cancel a running Roomote task.',
      inputSchema: z
        .object({
          taskId: nonEmptyTrimmedStringSchema.describe(
            'The non-empty Roomote task ID',
          ),
        })
        .strict(),
      execute: async ({ taskId }) => cancelFastAgentTask(context, taskId),
    }),
  };
}
