import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpConnectionAsanaConfig } from '@roomote/types';
import { z } from 'zod';

import { toMcpToolResult } from '../proxy-utils';

import { resolveAsanaAccessToken } from './connection';

const ASANA_API_BASE_URL = 'https://app.asana.com/api/1.0';

const TOOL_ANNOTATIONS = {
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
  readOnlyHint: true,
} as const;

const paginationSchema = {
  limit: z
    .number()
    .int()
    .positive()
    .max(100)
    .optional()
    .describe('Optional page size. Asana caps this at 100.'),
  offset: z
    .string()
    .optional()
    .describe('Pagination offset from a previous Asana next_page response.'),
} as const;

const optFieldsSchema = z
  .array(z.string().min(1))
  .optional()
  .describe('Optional list of Asana opt_fields to request.');

type AsanaListResponse = {
  data: unknown[];
  next_page?: {
    offset?: string | null;
    path?: string | null;
    uri?: string | null;
  } | null;
};

type AsanaSingleResponse = {
  data: unknown;
};

type AsanaErrorResponse = {
  errors?: Array<{
    message?: string;
    phrase?: string;
  }>;
};

function appendQueryParam(
  url: URL,
  key: string,
  value: string | number | boolean | string[] | undefined | null,
) {
  if (value === undefined || value === null) {
    return;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return;
    }

    url.searchParams.set(key, value.join(','));
    return;
  }

  url.searchParams.set(key, String(value));
}

async function asanaGet<T>(params: {
  accessToken: string;
  path: string;
  query?: Record<
    string,
    string | number | boolean | string[] | undefined | null
  >;
}): Promise<T> {
  const url = new URL(params.path, `${ASANA_API_BASE_URL}/`);

  for (const [key, value] of Object.entries(params.query ?? {})) {
    appendQueryParam(url, key, value);
  }

  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${params.accessToken}`,
    },
  });

  if (!response.ok) {
    const payload = (await response
      .json()
      .catch(() => null)) as AsanaErrorResponse | null;
    const message =
      payload?.errors
        ?.map((error) => error.message ?? error.phrase)
        .filter((error): error is string => Boolean(error))
        .join('; ') ||
      `Asana API request failed with status ${response.status}`;
    throw new Error(message);
  }

  return (await response.json()) as T;
}

function registerListWorkspacesTool(server: McpServer, accessToken: string) {
  server.registerTool(
    'list_workspaces',
    {
      title: 'List Workspaces',
      description: 'List Asana workspaces the configured token can access.',
      inputSchema: {
        ...paginationSchema,
        opt_fields: optFieldsSchema,
      },
      outputSchema: z.object({}).passthrough(),
      annotations: TOOL_ANNOTATIONS,
    },
    async ({ limit, offset, opt_fields }) => {
      const response = await asanaGet<AsanaListResponse>({
        accessToken,
        path: 'workspaces',
        query: {
          limit,
          offset,
          opt_fields,
        },
      });

      return toMcpToolResult({
        workspaces: response.data,
        next_page: response.next_page ?? null,
      });
    },
  );
}

function registerGetProjectTool(server: McpServer, accessToken: string) {
  server.registerTool(
    'get_project',
    {
      title: 'Get Project',
      description: 'Fetch an Asana project by gid.',
      inputSchema: {
        project_gid: z.string().min(1).describe('The Asana project gid.'),
        opt_fields: optFieldsSchema,
      },
      outputSchema: z.object({}).passthrough(),
      annotations: TOOL_ANNOTATIONS,
    },
    async ({ project_gid: projectGid, opt_fields }) => {
      const response = await asanaGet<AsanaSingleResponse>({
        accessToken,
        path: `projects/${projectGid}`,
        query: {
          opt_fields,
        },
      });

      return toMcpToolResult({ project: response.data });
    },
  );
}

function registerListProjectsTool(server: McpServer, accessToken: string) {
  server.registerTool(
    'list_projects',
    {
      title: 'List Projects',
      description: 'List projects in an Asana workspace.',
      inputSchema: {
        workspace_gid: z.string().min(1).describe('The Asana workspace gid.'),
        archived: z
          .boolean()
          .optional()
          .describe('Whether to include archived projects.'),
        ...paginationSchema,
        opt_fields: optFieldsSchema,
      },
      outputSchema: z.object({}).passthrough(),
      annotations: TOOL_ANNOTATIONS,
    },
    async ({
      workspace_gid: workspaceGid,
      archived,
      limit,
      offset,
      opt_fields,
    }) => {
      const response = await asanaGet<AsanaListResponse>({
        accessToken,
        path: 'projects',
        query: {
          workspace: workspaceGid,
          archived,
          limit,
          offset,
          opt_fields,
        },
      });

      return toMcpToolResult({
        projects: response.data,
        next_page: response.next_page ?? null,
      });
    },
  );
}

function registerGetTaskTool(server: McpServer, accessToken: string) {
  server.registerTool(
    'get_task',
    {
      title: 'Get Task',
      description: 'Fetch an Asana task by gid.',
      inputSchema: {
        task_gid: z.string().min(1).describe('The Asana task gid.'),
        opt_fields: optFieldsSchema,
      },
      outputSchema: z.object({}).passthrough(),
      annotations: TOOL_ANNOTATIONS,
    },
    async ({ task_gid: taskGid, opt_fields }) => {
      const response = await asanaGet<AsanaSingleResponse>({
        accessToken,
        path: `tasks/${taskGid}`,
        query: {
          opt_fields,
        },
      });

      return toMcpToolResult({ task: response.data });
    },
  );
}

function registerListTasksForProjectTool(
  server: McpServer,
  accessToken: string,
) {
  server.registerTool(
    'list_tasks_for_project',
    {
      title: 'List Tasks For Project',
      description: 'List tasks in an Asana project.',
      inputSchema: {
        project_gid: z.string().min(1).describe('The Asana project gid.'),
        completed_since: z
          .string()
          .optional()
          .describe(
            'Filter tasks by completion timestamp. Use `now` to show only incomplete tasks.',
          ),
        ...paginationSchema,
        opt_fields: optFieldsSchema,
      },
      outputSchema: z.object({}).passthrough(),
      annotations: TOOL_ANNOTATIONS,
    },
    async ({
      project_gid: projectGid,
      completed_since: completedSince,
      limit,
      offset,
      opt_fields,
    }) => {
      const response = await asanaGet<AsanaListResponse>({
        accessToken,
        path: 'tasks',
        query: {
          project: projectGid,
          completed_since: completedSince,
          limit,
          offset,
          opt_fields,
        },
      });

      return toMcpToolResult({
        tasks: response.data,
        next_page: response.next_page ?? null,
      });
    },
  );
}

function registerSearchTasksTool(server: McpServer, accessToken: string) {
  server.registerTool(
    'search_tasks',
    {
      title: 'Search Tasks',
      description: 'Search tasks within an Asana workspace.',
      inputSchema: {
        workspace_gid: z.string().min(1).describe('The Asana workspace gid.'),
        text: z.string().optional().describe('Free-text task search query.'),
        project: z
          .string()
          .optional()
          .describe('Optional project gid to scope the search.'),
        assignee: z
          .string()
          .optional()
          .describe('Optional assignee gid or `me`.'),
        completed: z
          .boolean()
          .optional()
          .describe('Optional completion filter.'),
        sort_by: z
          .enum([
            'created_at',
            'completed_at',
            'due_date',
            'likes',
            'modified_at',
          ])
          .optional()
          .describe('Optional Asana search sort field.'),
        sort_ascending: z
          .boolean()
          .optional()
          .describe('Optional search sort direction.'),
        ...paginationSchema,
        opt_fields: optFieldsSchema,
      },
      outputSchema: z.object({}).passthrough(),
      annotations: TOOL_ANNOTATIONS,
    },
    async ({
      workspace_gid: workspaceGid,
      text,
      project,
      assignee,
      completed,
      sort_by: sortBy,
      sort_ascending: sortAscending,
      limit,
      offset,
      opt_fields,
    }) => {
      const response = await asanaGet<AsanaListResponse>({
        accessToken,
        path: `workspaces/${workspaceGid}/tasks/search`,
        query: {
          text,
          'projects.any': project,
          'assignee.any': assignee,
          completed,
          sort_by: sortBy,
          sort_ascending: sortAscending,
          limit,
          offset,
          opt_fields,
        },
      });

      return toMcpToolResult({
        tasks: response.data,
        next_page: response.next_page ?? null,
      });
    },
  );
}

function registerGetTaskCommentsTool(server: McpServer, accessToken: string) {
  server.registerTool(
    'get_task_comments',
    {
      title: 'Get Task Comments',
      description: 'Fetch comment stories for an Asana task.',
      inputSchema: {
        task_gid: z.string().min(1).describe('The Asana task gid.'),
        ...paginationSchema,
        opt_fields: optFieldsSchema,
      },
      outputSchema: z.object({}).passthrough(),
      annotations: TOOL_ANNOTATIONS,
    },
    async ({ task_gid: taskGid, limit, offset, opt_fields }) => {
      const response = await asanaGet<AsanaListResponse>({
        accessToken,
        path: `tasks/${taskGid}/stories`,
        query: {
          limit,
          offset,
          opt_fields,
        },
      });

      const comments = response.data.filter((story) => {
        if (!story || typeof story !== 'object') {
          return false;
        }

        if ('type' in story && story.type === 'comment') {
          return true;
        }

        return (
          'resource_subtype' in story &&
          story.resource_subtype === 'comment_added'
        );
      });

      return toMcpToolResult({
        comments,
        next_page: response.next_page ?? null,
      });
    },
  );
}

function registerListTeamsTool(server: McpServer, accessToken: string) {
  server.registerTool(
    'list_teams',
    {
      title: 'List Teams',
      description: 'List teams in an Asana workspace.',
      inputSchema: {
        workspace_gid: z.string().min(1).describe('The Asana workspace gid.'),
        ...paginationSchema,
        opt_fields: optFieldsSchema,
      },
      outputSchema: z.object({}).passthrough(),
      annotations: TOOL_ANNOTATIONS,
    },
    async ({ workspace_gid: workspaceGid, limit, offset, opt_fields }) => {
      const response = await asanaGet<AsanaListResponse>({
        accessToken,
        path: `workspaces/${workspaceGid}/teams`,
        query: {
          limit,
          offset,
          opt_fields,
        },
      });

      return toMcpToolResult({
        teams: response.data,
        next_page: response.next_page ?? null,
      });
    },
  );
}

function registerGetUserTool(server: McpServer, accessToken: string) {
  server.registerTool(
    'get_user',
    {
      title: 'Get User',
      description: 'Fetch an Asana user by gid.',
      inputSchema: {
        user_gid: z.string().min(1).describe('The Asana user gid.'),
        opt_fields: optFieldsSchema,
      },
      outputSchema: z.object({}).passthrough(),
      annotations: TOOL_ANNOTATIONS,
    },
    async ({ user_gid: userGid, opt_fields }) => {
      const response = await asanaGet<AsanaSingleResponse>({
        accessToken,
        path: `users/${userGid}`,
        query: {
          opt_fields,
        },
      });

      return toMcpToolResult({ user: response.data });
    },
  );
}

export function registerAsanaTools(
  server: McpServer,
  config: McpConnectionAsanaConfig,
) {
  const accessToken = resolveAsanaAccessToken(config);

  registerListWorkspacesTool(server, accessToken);
  registerGetProjectTool(server, accessToken);
  registerListProjectsTool(server, accessToken);
  registerGetTaskTool(server, accessToken);
  registerListTasksForProjectTool(server, accessToken);
  registerSearchTasksTool(server, accessToken);
  registerGetTaskCommentsTool(server, accessToken);
  registerListTeamsTool(server, accessToken);
  registerGetUserTool(server, accessToken);
}
