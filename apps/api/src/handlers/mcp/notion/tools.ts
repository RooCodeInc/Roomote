import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpConnectionNotionConfig } from '@roomote/types';
import { z } from 'zod';

import { toMcpToolResult } from '../proxy-utils';
import { notionApiRequestJson } from './api';

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
        'Search pages and data sources explicitly shared with the deployment Notion integration.',
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
        'Fetch a page, data source, or block explicitly shared with the deployment Notion integration. Page and block fetches include one page of child blocks.',
      inputSchema: {
        id: nonEmptyStringSchema,
        object_type: z.enum(['page', 'data_source', 'block']).default('page'),
        ...paginationSchema,
      },
      outputSchema: z.object({}).passthrough(),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ id, object_type: objectType, start_cursor, page_size }) => {
      const encodedId = encodeURIComponent(id);
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
        'Update properties or trash state for a page available to the deployment Notion integration.',
      inputSchema: {
        page_id: nonEmptyStringSchema,
        properties: jsonObjectSchema.optional(),
        icon: jsonObjectSchema.nullable().optional(),
        cover: jsonObjectSchema.nullable().optional(),
        in_trash: z.boolean().optional(),
      },
      outputSchema: z.object({}).passthrough(),
      annotations: WRITE_ANNOTATIONS,
    },
    async ({ page_id: pageId, properties, icon, cover, in_trash }) => {
      const page = await notionApiRequestJson<Record<string, unknown>>({
        config,
        path: `pages/${encodeURIComponent(pageId)}`,
        method: 'PATCH',
        body: {
          ...(properties ? { properties } : {}),
          ...(icon !== undefined ? { icon } : {}),
          ...(cover !== undefined ? { cover } : {}),
          ...(in_trash !== undefined ? { in_trash } : {}),
        },
      });
      return toMcpToolResult({ page });
    },
  );
}

function registerAppendBlocksTool(
  server: McpServer,
  config: McpConnectionNotionConfig,
) {
  const toolName = 'notion-append-blocks';
  server.registerTool(
    toolName,
    {
      title: 'Append Notion Blocks',
      description:
        'Append content blocks to a page or block available to the deployment Notion integration.',
      inputSchema: {
        block_id: nonEmptyStringSchema,
        children: z.array(jsonObjectSchema).min(1).max(100),
        after: z.string().optional(),
      },
      outputSchema: z.object({}).passthrough(),
      annotations: WRITE_ANNOTATIONS,
    },
    async ({ block_id: blockId, children, after }) => {
      const response = await notionApiRequestJson<Record<string, unknown>>({
        config,
        path: `blocks/${encodeURIComponent(blockId)}/children`,
        method: 'PATCH',
        body: { children, ...(after ? { after } : {}) },
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
  registerAppendBlocksTool(server, config);
  registerCreateCommentTool(server, config);
}
