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

interface FastAgentTaskApiContext {
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
  const url = new URL(path, `${resolvedApiBaseUrl}/`);

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

const fastAgentTaskStatusSchema = z.enum(['active', 'completed', 'all']);
const fastAgentTaskOrderSchema = z.enum(['asc', 'desc']);
const fastAgentTaskTypeSchema = z.enum(['standard']);

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
          prompt: z
            .string()
            .trim()
            .min(1)
            .describe('The coding request or task description'),
          environmentId: z
            .string()
            .trim()
            .min(1)
            .optional()
            .describe(
              'Optional environment ID. Omit it or pass "__all_repositories__" to use the deployment-wide default target',
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
          query: z
            .string()
            .trim()
            .min(1)
            .optional()
            .describe('Optional text to match against task titles and prompts'),
          status: fastAgentTaskStatusSchema
            .optional()
            .describe('Optional task-status filter'),
          limit: z
            .number()
            .int()
            .min(1)
            .max(100)
            .optional()
            .describe('Maximum number of tasks to return'),
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
          taskId: z.string().trim().min(1).describe('The Roomote task ID'),
          limit: z
            .number()
            .int()
            .min(1)
            .max(1000)
            .optional()
            .describe('Maximum number of messages to return'),
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
          taskId: z.string().trim().min(1).describe('The Roomote task ID'),
          message: z
            .string()
            .trim()
            .min(1)
            .describe('The follow-up message to send'),
        })
        .strict(),
      execute: async ({ taskId, message }) =>
        callFastAgentTaskApi({
          ...context,
          method: 'POST',
          path: `${FAST_AGENT_TASKS_API_PATH}/${taskId}/send_message`,
          body: { message },
        }),
    }),
    cancel_task: tool({
      description: 'Cancel a running Roomote task.',
      inputSchema: z
        .object({
          taskId: z.string().trim().min(1).describe('The Roomote task ID'),
        })
        .strict(),
      execute: async ({ taskId }) =>
        callFastAgentTaskApi({
          ...context,
          method: 'POST',
          path: `${FAST_AGENT_TASKS_API_PATH}/${taskId}/cancel`,
        }),
    }),
  };
}
