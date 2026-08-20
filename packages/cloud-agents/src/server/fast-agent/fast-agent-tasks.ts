import { tool, type ToolSet } from 'ai';
import { createAuthToken } from '@roomote/auth';
import {
  ALL_REPOSITORIES,
  roomoteTaskInspectionArgsSchema,
  type RoomoteTaskInspectionArgs,
} from '@roomote/types';
import { z } from 'zod';

import { resolveApiBaseUrl } from '../shared-utils';
import {
  FAST_AGENT_ENVIRONMENTS_API_PATH,
  FAST_AGENT_TASKS_API_PATH,
} from './fast-agent-constants';

type FastAgentTaskToolResult = Record<string, unknown>;

type FastAgentTaskSearchRow = Record<string, unknown> & {
  id: string;
  lastMessageAt: number;
};

const FAST_AGENT_TASK_SEARCH_SCOPE_CHUNK_SIZE = 100;

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
  params: { taskId: string; message: string },
): Promise<FastAgentTaskToolResult> {
  return callFastAgentTaskApi({
    ...context,
    method: 'POST',
    path: `${FAST_AGENT_TASKS_API_PATH}/${params.taskId}/steer_message`,
    body: { message: params.message },
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

export async function inspectFastAgentTasks(
  context: FastAgentTaskApiContext,
  params: RoomoteTaskInspectionArgs,
  allowedTaskIds: ReadonlySet<string>,
): Promise<FastAgentTaskToolResult> {
  const args = roomoteTaskInspectionArgsSchema.parse(params);

  if (args.action === 'search') {
    if (allowedTaskIds.size === 0) {
      return { tasks: [], hasMore: false };
    }

    const limit = Math.min(args.limit ?? 20, 100);
    const taskIdChunks: string[][] = [];
    const taskIds = [...allowedTaskIds];
    for (
      let index = 0;
      index < taskIds.length;
      index += FAST_AGENT_TASK_SEARCH_SCOPE_CHUNK_SIZE
    ) {
      taskIdChunks.push(
        taskIds.slice(index, index + FAST_AGENT_TASK_SEARCH_SCOPE_CHUNK_SIZE),
      );
    }

    const results = await Promise.all(
      taskIdChunks.map((taskIdChunk) =>
        callFastAgentTaskApi({
          ...context,
          method: 'GET',
          path: FAST_AGENT_TASKS_API_PATH,
          query: {
            query: args.query,
            status: args.status,
            limit,
            cursor: args.cursor,
            pullRequest: args.pullRequest,
            taskIds: taskIdChunk.join(','),
          },
        }),
      ),
    );
    const invalidResult = results.find(
      (result) => !Array.isArray(result.tasks),
    );
    if (invalidResult) return invalidResult;

    const tasks = results
      .flatMap((result) => result.tasks as FastAgentTaskSearchRow[])
      .sort(
        (left, right) =>
          right.lastMessageAt - left.lastMessageAt ||
          right.id.localeCompare(left.id),
      );
    const selectedTasks = tasks.slice(0, limit);
    const hasMore =
      tasks.length > limit || results.some((result) => result.hasMore === true);
    const lastTask = hasMore ? selectedTasks.at(-1) : undefined;

    return {
      tasks: selectedTasks,
      hasMore,
      ...(lastTask
        ? { nextCursor: `${lastTask.lastMessageAt}:${lastTask.id}` }
        : {}),
    };
  }

  const taskId = args.taskId?.trim();
  if (!taskId) {
    return {
      success: false,
      error: `taskId is required for ${args.action}`,
    };
  }
  if (!allowedTaskIds.has(taskId)) {
    return {
      success: false,
      error: 'That task was not delegated by this Fast conversation.',
    };
  }

  const actionPath = {
    get_summary: 'summary',
    get_compute_logs: 'compute_logs',
    get_messages: 'messages',
  }[args.action];

  return callFastAgentTaskApi({
    ...context,
    method: 'GET',
    path: `${FAST_AGENT_TASKS_API_PATH}/${encodeURIComponent(taskId)}/${actionPath}`,
    ...(args.action === 'get_messages'
      ? { query: { limit: args.limit, order: 'desc' } }
      : {}),
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
        })
        .strict(),
      execute: async ({ prompt, environmentId, type }) =>
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
      description: 'Send a follow-up message to a running Roomote task.',
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
