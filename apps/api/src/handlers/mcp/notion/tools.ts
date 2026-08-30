import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { notionApiRequestJson } from '@roomote/sdk/server/notion-api';
import type { McpConnectionNotionConfig } from '@roomote/types';
import { z } from 'zod';

import { toMcpToolResult } from '../proxy-utils';

const READ_ONLY_ANNOTATIONS = {
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
  readOnlyHint: true,
} as const;

const WRITE_ANNOTATIONS = {
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
  readOnlyHint: false,
} as const;

const nonEmptyStringSchema = z.string().trim().min(1);
const jsonObjectSchema = z.record(z.string(), z.unknown());
const paginationSchema = {
  start_cursor: z.string().optional(),
  page_size: z.number().int().min(1).max(100).optional(),
} as const;
const blockPositionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('start') }),
  z.object({ type: z.literal('end') }),
  z.object({
    type: z.literal('after_block'),
    after_block: z.object({ id: nonEmptyStringSchema }),
  }),
]);
const pageParentSchema = z.union([
  z.object({
    type: z.literal('page_id'),
    page_id: nonEmptyStringSchema,
  }),
  z.object({
    type: z.literal('data_source_id'),
    data_source_id: nonEmptyStringSchema,
  }),
]);
const markdownOperationSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('update_content'),
    update_content: z.object({
      content_updates: z
        .array(
          z.object({
            old_str: nonEmptyStringSchema,
            new_str: z.string(),
            replace_all_matches: z.boolean().optional(),
          }),
        )
        .min(1)
        .max(100),
      allow_deleting_content: z.boolean().optional(),
    }),
  }),
  z.object({
    type: z.literal('replace_content'),
    replace_content: z.object({
      new_str: z.string(),
      allow_deleting_content: z.boolean().optional(),
    }),
  }),
]);

function registerSearchTool(
  server: McpServer,
  config: McpConnectionNotionConfig,
) {
  const toolName = 'notion-search';
  server.registerTool(
    toolName,
    {
      title: 'Search Notion',
      description:
        'Search pages and data sources explicitly shared with the deployment Notion integration. Pages that live inside databases are often missing from search results: to find them, locate the data source (object_type "data_source") and list its rows with notion-query-data-sources.',
      inputSchema: {
        query: z.string().optional(),
        object_type: z.enum(['page', 'data_source']).optional(),
        ...paginationSchema,
      },
      outputSchema: z.object({}).passthrough(),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ query, object_type: objectType, start_cursor, page_size }) => {
      const response = await notionApiRequestJson<Record<string, unknown>>({
        config,
        path: 'search',
        method: 'POST',
        body: {
          ...(query ? { query } : {}),
          ...(objectType
            ? { filter: { property: 'object', value: objectType } }
            : {}),
          ...(start_cursor ? { start_cursor } : {}),
          ...(page_size ? { page_size } : {}),
        },
      });

      return toMcpToolResult(response);
    },
  );
}

function registerFetchTool(
  server: McpServer,
  config: McpConnectionNotionConfig,
) {
  const toolName = 'notion-fetch';
  server.registerTool(
    toolName,
    {
      title: 'Fetch Notion Content',
      description:
        'Fetch a page, database, data source, or block explicitly shared with the deployment Notion integration. Pages include enhanced Markdown content; databases list their data sources (query rows with notion-query-data-sources); blocks include one page of child blocks.',
      inputSchema: {
        id: nonEmptyStringSchema,
        object_type: z
          .enum(['page', 'database', 'data_source', 'block'])
          .default('page'),
        include_transcript: z.boolean().optional(),
        ...paginationSchema,
      },
      outputSchema: z.object({}).passthrough(),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({
      id,
      object_type: objectType,
      include_transcript,
      start_cursor,
      page_size,
    }) => {
      const encodedId = encodeURIComponent(id);
      if (objectType === 'database') {
        const database = await notionApiRequestJson<Record<string, unknown>>({
          config,
          path: `databases/${encodedId}`,
        });
        return toMcpToolResult({ database });
      }
      if (objectType === 'data_source') {
        const dataSource = await notionApiRequestJson<Record<string, unknown>>({
          config,
          path: `data_sources/${encodedId}`,
        });
        return toMcpToolResult({ data_source: dataSource });
      }

      const object = await notionApiRequestJson<Record<string, unknown>>({
        config,
        path:
          objectType === 'page' ? `pages/${encodedId}` : `blocks/${encodedId}`,
      });
      if (objectType === 'page') {
        const content = await notionApiRequestJson<Record<string, unknown>>({
          config,
          path: `pages/${encodedId}/markdown`,
          query: { include_transcript },
        });
        return toMcpToolResult({ page: object, content });
      }

      const children = await notionApiRequestJson<Record<string, unknown>>({
        config,
        path: `blocks/${encodedId}/children`,
        query: { start_cursor, page_size },
      });

      return toMcpToolResult({
        [objectType]: object,
        children,
      });
    },
  );
}

function registerQueryDataSourceTool(
  server: McpServer,
  config: McpConnectionNotionConfig,
) {
  const toolName = 'notion-query-data-sources';
  server.registerTool(
    toolName,
    {
      title: 'Query Notion Data Source',
      description:
        'Query rows from a data source explicitly shared with the deployment Notion integration.',
      inputSchema: {
        data_source_id: nonEmptyStringSchema,
        filter: jsonObjectSchema.optional(),
        sorts: z.array(jsonObjectSchema).optional(),
        ...paginationSchema,
      },
      outputSchema: z.object({}).passthrough(),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({
      data_source_id: dataSourceId,
      filter,
      sorts,
      start_cursor,
      page_size,
    }) => {
      const response = await notionApiRequestJson<Record<string, unknown>>({
        config,
        path: `data_sources/${encodeURIComponent(dataSourceId)}/query`,
        method: 'POST',
        body: {
          ...(filter ? { filter } : {}),
          ...(sorts ? { sorts } : {}),
          ...(start_cursor ? { start_cursor } : {}),
          ...(page_size ? { page_size } : {}),
        },
      });
      return toMcpToolResult(response);
    },
  );
}

function registerGetCommentsTool(
  server: McpServer,
  config: McpConnectionNotionConfig,
) {
  const toolName = 'notion-get-comments';
  server.registerTool(
    toolName,
    {
      title: 'Get Notion Comments',
      description:
        'List comments on a page or block explicitly shared with the deployment Notion integration.',
      inputSchema: {
        block_id: nonEmptyStringSchema,
        ...paginationSchema,
      },
      outputSchema: z.object({}).passthrough(),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ block_id: blockId, start_cursor, page_size }) => {
      const response = await notionApiRequestJson<Record<string, unknown>>({
        config,
        path: 'comments',
        query: { block_id: blockId, start_cursor, page_size },
      });
      return toMcpToolResult(response);
    },
  );
}

function registerCreatePagesTool(
  server: McpServer,
  config: McpConnectionNotionConfig,
) {
  const toolName = 'notion-create-pages';
  server.registerTool(
    toolName,
    {
      title: 'Create Notion Page',
      description:
        'Create a page beneath a parent page or data source available to the deployment Notion integration.',
      inputSchema: {
        parent: jsonObjectSchema,
        properties: jsonObjectSchema,
        children: z.array(jsonObjectSchema).optional(),
        icon: jsonObjectSchema.optional(),
        cover: jsonObjectSchema.optional(),
      },
      outputSchema: z.object({}).passthrough(),
      annotations: WRITE_ANNOTATIONS,
    },
    async ({ parent, properties, children, icon, cover }) => {
      const page = await notionApiRequestJson<Record<string, unknown>>({
        config,
        path: 'pages',
        method: 'POST',
        body: {
          parent,
          properties,
          ...(children ? { children } : {}),
          ...(icon ? { icon } : {}),
          ...(cover ? { cover } : {}),
        },
      });
      return toMcpToolResult({ page });
    },
  );
}

function registerUpdatePageTool(
  server: McpServer,
  config: McpConnectionNotionConfig,
) {
  const toolName = 'notion-update-page';
  server.registerTool(
    toolName,
    {
      title: 'Update Notion Page',
      description:
        'Update properties, content, icon, cover, or trash state for a page available to the deployment Notion integration.',
      inputSchema: {
        page_id: nonEmptyStringSchema,
        properties: jsonObjectSchema.optional(),
        icon: jsonObjectSchema.nullable().optional(),
        cover: jsonObjectSchema.nullable().optional(),
        in_trash: z.boolean().optional(),
        content: markdownOperationSchema.optional(),
        allow_async: z.boolean().optional(),
      },
      outputSchema: z.object({}).passthrough(),
      annotations: WRITE_ANNOTATIONS,
    },
    async ({
      page_id: pageId,
      properties,
      icon,
      cover,
      in_trash,
      content,
      allow_async,
    }) => {
      const encodedPageId = encodeURIComponent(pageId);
      const hasMetadataUpdate =
        properties !== undefined ||
        icon !== undefined ||
        cover !== undefined ||
        in_trash !== undefined;
      if (!hasMetadataUpdate && !content) {
        throw new Error('Specify at least one page update');
      }

      const page = hasMetadataUpdate
        ? await notionApiRequestJson<Record<string, unknown>>({
            config,
            path: `pages/${encodedPageId}`,
            method: 'PATCH',
            body: {
              ...(properties ? { properties } : {}),
              ...(icon !== undefined ? { icon } : {}),
              ...(cover !== undefined ? { cover } : {}),
              ...(in_trash !== undefined ? { in_trash } : {}),
            },
          })
        : undefined;
      const updatedContent = content
        ? await notionApiRequestJson<Record<string, unknown>>({
            config,
            path: `pages/${encodedPageId}/markdown`,
            method: 'PATCH',
            body: {
              ...content,
              ...(allow_async !== undefined ? { allow_async } : {}),
            },
          })
        : undefined;
      return toMcpToolResult({
        ...(page ? { page } : {}),
        ...(updatedContent ? { content: updatedContent } : {}),
      });
    },
  );
}

function registerGetAsyncTaskTool(
  server: McpServer,
  config: McpConnectionNotionConfig,
) {
  const toolName = 'notion-get-async-task';
  server.registerTool(
    toolName,
    {
      title: 'Get Notion Async Task',
      description:
        'Get the current status and result or error for an asynchronous Notion operation.',
      inputSchema: { task_id: nonEmptyStringSchema },
      outputSchema: z.object({}).passthrough(),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ task_id: taskId }) => {
      const response = await notionApiRequestJson<Record<string, unknown>>({
        config,
        path: `async_tasks/${encodeURIComponent(taskId)}`,
      });
      return toMcpToolResult(response);
    },
  );
}

function registerMovePagesTool(
  server: McpServer,
  config: McpConnectionNotionConfig,
) {
  const toolName = 'notion-move-pages';
  server.registerTool(
    toolName,
    {
      title: 'Move Notion Pages',
      description:
        'Move one or more regular Notion pages beneath another page or into a data source available to the deployment integration. The public API cannot move databases or blocks.',
      inputSchema: {
        page_ids: z.array(nonEmptyStringSchema).min(1).max(100),
        parent: pageParentSchema,
      },
      outputSchema: z.object({}).passthrough(),
      annotations: WRITE_ANNOTATIONS,
    },
    async ({ page_ids: pageIds, parent }) => {
      const pages = [];
      for (const pageId of pageIds) {
        pages.push(
          await notionApiRequestJson<Record<string, unknown>>({
            config,
            path: `pages/${encodeURIComponent(pageId)}/move`,
            method: 'POST',
            body: { parent },
          }),
        );
      }
      return toMcpToolResult({ pages });
    },
  );
}

function registerInsertBlocksTool(
  server: McpServer,
  config: McpConnectionNotionConfig,
) {
  const toolName = 'notion-insert-blocks';
  server.registerTool(
    toolName,
    {
      title: 'Insert Notion Blocks',
      description:
        'Create content blocks at the start or end of a page or block, or after an existing child block. Notion cannot move or reorder existing blocks; position applies only to newly created blocks.',
      inputSchema: {
        block_id: nonEmptyStringSchema,
        children: z.array(jsonObjectSchema).min(1).max(100),
        position: blockPositionSchema.optional(),
      },
      outputSchema: z.object({}).passthrough(),
      annotations: WRITE_ANNOTATIONS,
    },
    async ({ block_id: blockId, children, position }) => {
      const response = await notionApiRequestJson<Record<string, unknown>>({
        config,
        path: `blocks/${encodeURIComponent(blockId)}/children`,
        method: 'PATCH',
        body: {
          children,
          ...(position ? { position } : {}),
        },
      });
      return toMcpToolResult(response);
    },
  );
}

function registerCreateCommentTool(
  server: McpServer,
  config: McpConnectionNotionConfig,
) {
  const toolName = 'notion-create-comment';
  server.registerTool(
    toolName,
    {
      title: 'Create Notion Comment',
      description:
        'Create a comment on a page available to the deployment Notion integration.',
      inputSchema: {
        parent: jsonObjectSchema,
        rich_text: z.array(jsonObjectSchema).min(1),
      },
      outputSchema: z.object({}).passthrough(),
      annotations: WRITE_ANNOTATIONS,
    },
    async ({ parent, rich_text: richText }) => {
      const comment = await notionApiRequestJson<Record<string, unknown>>({
        config,
        path: 'comments',
        method: 'POST',
        body: { parent, rich_text: richText },
      });
      return toMcpToolResult({ comment });
    },
  );
}

export function registerNotionTools(
  server: McpServer,
  config: McpConnectionNotionConfig,
) {
  registerSearchTool(server, config);
  registerFetchTool(server, config);
  registerQueryDataSourceTool(server, config);
  registerGetCommentsTool(server, config);
  registerCreatePagesTool(server, config);
  registerUpdatePageTool(server, config);
  registerGetAsyncTaskTool(server, config);
  registerMovePagesTool(server, config);
  registerInsertBlocksTool(server, config);
  registerCreateCommentTool(server, config);
}
