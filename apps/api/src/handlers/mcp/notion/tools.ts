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

const DESTRUCTIVE_WRITE_ANNOTATIONS = {
  ...WRITE_ANNOTATIONS,
  destructiveHint: true,
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
const databaseParentSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('page_id'),
    page_id: nonEmptyStringSchema,
  }),
  z.object({
    type: z.literal('workspace'),
    workspace: z.literal(true),
  }),
]);
const dataSourceParentSchema = z.object({
  type: z.literal('database_id'),
  database_id: nonEmptyStringSchema,
});
const viewPositionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('start') }),
  z.object({ type: z.literal('end') }),
  z.object({
    type: z.literal('after_view'),
    view_id: nonEmptyStringSchema,
  }),
]);
const viewPlacementSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('new_row'),
    row_index: z.number().int().min(0).optional(),
  }),
  z.object({
    type: z.literal('existing_row'),
    row_index: z.number().int().min(0),
  }),
]);
const viewParentSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('database_id'),
      database_id: nonEmptyStringSchema,
      position: viewPositionSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('view_id'),
      view_id: nonEmptyStringSchema,
      placement: viewPlacementSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('create_database'),
      create_database: z.object({
        parent: z.object({
          type: z.literal('page_id'),
          page_id: nonEmptyStringSchema,
        }),
        position: z
          .object({
            type: z.literal('after_block'),
            block_id: nonEmptyStringSchema,
          })
          .optional(),
      }),
    })
    .strict(),
]);
const viewTypeSchema = z.enum([
  'table',
  'board',
  'list',
  'calendar',
  'timeline',
  'gallery',
  'form',
  'chart',
  'map',
  'dashboard',
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

function registerCreateDatabaseTool(
  server: McpServer,
  config: McpConnectionNotionConfig,
) {
  const toolName = 'notion-create-database';
  server.registerTool(
    toolName,
    {
      title: 'Create Notion Database',
      description:
        'Create a database, its initial data source, and its first table view beneath a shared page or as a private workspace page. Requires Insert content capability and access to the parent page.',
      inputSchema: {
        parent: databaseParentSchema.describe(
          'A shared page parent, or the workspace for a private database.',
        ),
        title: z
          .array(jsonObjectSchema)
          .max(100)
          .optional()
          .describe('Notion rich-text objects for the database title.'),
        description: z
          .array(jsonObjectSchema)
          .max(100)
          .optional()
          .describe('Notion rich-text objects for the database description.'),
        is_inline: z
          .boolean()
          .optional()
          .describe('Display the database inline in its parent page.'),
        initial_data_source: z
          .object({ properties: jsonObjectSchema.optional() })
          .optional()
          .describe(
            'Optional initial data source schema, with property names mapped to Notion property configuration objects.',
          ),
        icon: jsonObjectSchema.optional(),
        cover: jsonObjectSchema.optional(),
      },
      outputSchema: z.object({}).passthrough(),
      annotations: WRITE_ANNOTATIONS,
    },
    async ({
      parent,
      title,
      description,
      is_inline: isInline,
      initial_data_source: initialDataSource,
      icon,
      cover,
    }) => {
      const database = await notionApiRequestJson<Record<string, unknown>>({
        config,
        path: 'databases',
        method: 'POST',
        body: {
          parent,
          ...(title ? { title } : {}),
          ...(description ? { description } : {}),
          ...(isInline !== undefined ? { is_inline: isInline } : {}),
          ...(initialDataSource
            ? { initial_data_source: initialDataSource }
            : {}),
          ...(icon ? { icon } : {}),
          ...(cover ? { cover } : {}),
        },
      });
      return toMcpToolResult({ database });
    },
  );
}

function registerUpdateDatabaseTool(
  server: McpServer,
  config: McpConnectionNotionConfig,
) {
  const toolName = 'notion-update-database';
  server.registerTool(
    toolName,
    {
      title: 'Update Notion Database',
      description:
        'Update a database title, description, icon, cover, inline display, parent, lock state, or trash state. Requires Update content capability and access to the database and any new parent.',
      inputSchema: {
        database_id: nonEmptyStringSchema,
        parent: databaseParentSchema.optional(),
        title: z.array(jsonObjectSchema).max(100).optional(),
        description: z.array(jsonObjectSchema).max(100).optional(),
        is_inline: z.boolean().optional(),
        icon: jsonObjectSchema.optional(),
        cover: jsonObjectSchema.optional(),
        in_trash: z.boolean().optional(),
        is_locked: z.boolean().optional(),
      },
      outputSchema: z.object({}).passthrough(),
      annotations: WRITE_ANNOTATIONS,
    },
    async ({
      database_id: databaseId,
      parent,
      title,
      description,
      is_inline: isInline,
      icon,
      cover,
      in_trash: inTrash,
      is_locked: isLocked,
    }) => {
      if (
        parent === undefined &&
        title === undefined &&
        description === undefined &&
        isInline === undefined &&
        icon === undefined &&
        cover === undefined &&
        inTrash === undefined &&
        isLocked === undefined
      ) {
        throw new Error('Specify at least one database update');
      }

      const database = await notionApiRequestJson<Record<string, unknown>>({
        config,
        path: `databases/${encodeURIComponent(databaseId)}`,
        method: 'PATCH',
        body: {
          ...(parent ? { parent } : {}),
          ...(title ? { title } : {}),
          ...(description ? { description } : {}),
          ...(isInline !== undefined ? { is_inline: isInline } : {}),
          ...(icon ? { icon } : {}),
          ...(cover ? { cover } : {}),
          ...(inTrash !== undefined ? { in_trash: inTrash } : {}),
          ...(isLocked !== undefined ? { is_locked: isLocked } : {}),
        },
      });
      return toMcpToolResult({ database });
    },
  );
}

function registerUpdateDataSourceTool(
  server: McpServer,
  config: McpConnectionNotionConfig,
) {
  const toolName = 'notion-update-data-source';
  server.registerTool(
    toolName,
    {
      title: 'Update Notion Data Source',
      description:
        'Update a data source title, icon, parent, trash state, or property schema. In properties, use a new property name with a configuration object to add it, an existing property name or ID with { name } to rename it, or null to delete it.',
      inputSchema: {
        data_source_id: nonEmptyStringSchema,
        title: z.array(jsonObjectSchema).max(100).optional(),
        icon: jsonObjectSchema.nullable().optional(),
        properties: z
          .record(z.string(), jsonObjectSchema.nullable())
          .refine((value) => Object.keys(value).length > 0, {
            message: 'Specify at least one property update',
          })
          .optional(),
        parent: dataSourceParentSchema.optional(),
        in_trash: z.boolean().optional(),
      },
      outputSchema: z.object({}).passthrough(),
      annotations: WRITE_ANNOTATIONS,
    },
    async ({
      data_source_id: dataSourceId,
      title,
      icon,
      properties,
      parent,
      in_trash: inTrash,
    }) => {
      if (
        title === undefined &&
        icon === undefined &&
        properties === undefined &&
        parent === undefined &&
        inTrash === undefined
      ) {
        throw new Error('Specify at least one data source update');
      }

      const dataSource = await notionApiRequestJson<Record<string, unknown>>({
        config,
        path: `data_sources/${encodeURIComponent(dataSourceId)}`,
        method: 'PATCH',
        body: {
          ...(title ? { title } : {}),
          ...(icon !== undefined ? { icon } : {}),
          ...(properties ? { properties } : {}),
          ...(parent ? { parent } : {}),
          ...(inTrash !== undefined ? { in_trash: inTrash } : {}),
        },
      });
      return toMcpToolResult({ data_source: dataSource });
    },
  );
}

function registerCreateViewTool(
  server: McpServer,
  config: McpConnectionNotionConfig,
) {
  const toolName = 'notion-create-view';
  server.registerTool(
    toolName,
    {
      title: 'Create Notion View',
      description:
        'Create a view in a database, a widget in a dashboard view, or a view in a new linked database block. Requires Insert content and Update content capabilities.',
      inputSchema: {
        parent: viewParentSchema,
        data_source_id: nonEmptyStringSchema,
        name: nonEmptyStringSchema,
        type: viewTypeSchema,
        filter: jsonObjectSchema.optional(),
        sorts: z.array(jsonObjectSchema).max(100).optional(),
        quick_filters: z.record(z.string(), jsonObjectSchema).optional(),
        configuration: jsonObjectSchema.optional(),
      },
      outputSchema: z.object({}).passthrough(),
      annotations: WRITE_ANNOTATIONS,
    },
    async ({
      parent,
      data_source_id: dataSourceId,
      name,
      type,
      filter,
      sorts,
      quick_filters: quickFilters,
      configuration,
    }) => {
      const view = await notionApiRequestJson<Record<string, unknown>>({
        config,
        path: 'views',
        method: 'POST',
        body: {
          ...(parent.type === 'database_id'
            ? {
                database_id: parent.database_id,
                ...(parent.position ? { position: parent.position } : {}),
              }
            : parent.type === 'view_id'
              ? {
                  view_id: parent.view_id,
                  ...(parent.placement ? { placement: parent.placement } : {}),
                }
              : { create_database: parent.create_database }),
          data_source_id: dataSourceId,
          name,
          type,
          ...(filter ? { filter } : {}),
          ...(sorts ? { sorts } : {}),
          ...(quickFilters ? { quick_filters: quickFilters } : {}),
          ...(configuration ? { configuration } : {}),
        },
      });
      return toMcpToolResult({ view });
    },
  );
}

function registerUpdateViewTool(
  server: McpServer,
  config: McpConnectionNotionConfig,
) {
  const toolName = 'notion-update-view';
  server.registerTool(
    toolName,
    {
      title: 'Update Notion View',
      description:
        'Update a view name, filter, property sorts, quick filters, or presentation configuration. Pass null for filter, sorts, or quick_filters to clear them.',
      inputSchema: {
        view_id: nonEmptyStringSchema,
        name: nonEmptyStringSchema.optional(),
        filter: jsonObjectSchema.nullable().optional(),
        sorts: z.array(jsonObjectSchema).max(100).nullable().optional(),
        quick_filters: z
          .record(z.string(), jsonObjectSchema.nullable())
          .nullable()
          .optional(),
        configuration: jsonObjectSchema.optional(),
      },
      outputSchema: z.object({}).passthrough(),
      annotations: WRITE_ANNOTATIONS,
    },
    async ({
      view_id: viewId,
      name,
      filter,
      sorts,
      quick_filters: quickFilters,
      configuration,
    }) => {
      if (
        name === undefined &&
        filter === undefined &&
        sorts === undefined &&
        quickFilters === undefined &&
        configuration === undefined
      ) {
        throw new Error('Specify at least one view update');
      }

      const view = await notionApiRequestJson<Record<string, unknown>>({
        config,
        path: `views/${encodeURIComponent(viewId)}`,
        method: 'PATCH',
        body: {
          ...(name !== undefined ? { name } : {}),
          ...(filter !== undefined ? { filter } : {}),
          ...(sorts !== undefined ? { sorts } : {}),
          ...(quickFilters !== undefined
            ? { quick_filters: quickFilters }
            : {}),
          ...(configuration ? { configuration } : {}),
        },
      });
      return toMcpToolResult({ view });
    },
  );
}

function registerDeleteViewTool(
  server: McpServer,
  config: McpConnectionNotionConfig,
) {
  const toolName = 'notion-delete-view';
  server.registerTool(
    toolName,
    {
      title: 'Delete Notion View',
      description:
        'Delete a view from a database. Notion does not allow deleting the last remaining view.',
      inputSchema: { view_id: nonEmptyStringSchema },
      outputSchema: z.object({}).passthrough(),
      annotations: DESTRUCTIVE_WRITE_ANNOTATIONS,
    },
    async ({ view_id: viewId }) => {
      const view = await notionApiRequestJson<Record<string, unknown>>({
        config,
        path: `views/${encodeURIComponent(viewId)}`,
        method: 'DELETE',
      });
      return toMcpToolResult({ view });
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
  registerCreateDatabaseTool(server, config);
  registerUpdateDatabaseTool(server, config);
  registerUpdateDataSourceTool(server, config);
  registerCreateViewTool(server, config);
  registerUpdateViewTool(server, config);
  registerDeleteViewTool(server, config);
  registerUpdatePageTool(server, config);
  registerGetAsyncTaskTool(server, config);
  registerMovePagesTool(server, config);
  registerInsertBlocksTool(server, config);
  registerCreateCommentTool(server, config);
}
