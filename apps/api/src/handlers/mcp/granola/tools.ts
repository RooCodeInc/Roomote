import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpConnectionGranolaConfig } from '@roomote/types';
import { z } from 'zod';

import { toMcpToolResult } from '../proxy-utils';
import { granolaApiGetJson } from './api';

const TOOL_ANNOTATIONS = {
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
  readOnlyHint: true,
} as const;

const folderIdPattern = /^fol_[a-zA-Z0-9]{14}$/;
const noteIdPattern = /^not_[a-zA-Z0-9]{14}$/;

const paginationSchema = {
  cursor: z
    .string()
    .optional()
    .describe('Cursor returned by the previous Granola response.'),
  page_size: z
    .number()
    .int()
    .refine((value) => value >= 1 && value <= 30, {
      message: 'Page size must be between 1 and 30.',
    })
    .optional()
    .describe('Results per page from 1 to 30. Granola defaults to 10.'),
} as const;

const dateFilterSchema = z
  .string()
  .refine((value) => value.length > 0, {
    message: 'Date filter must be non-empty.',
  })
  .optional()
  .describe(
    'An ISO 8601 date or date-time, for example 2026-01-27 or 2026-01-27T15:30:00Z.',
  );

type ListNotesResponse = {
  notes: unknown[];
  hasMore: boolean;
  cursor: string | null;
};

type ListFoldersResponse = {
  folders: unknown[];
  hasMore: boolean;
  cursor: string | null;
};

function registerListNotesTool(
  server: McpServer,
  config: McpConnectionGranolaConfig,
) {
  server.registerTool(
    'list_notes',
    {
      title: 'List Notes',
      description: 'List Granola notes available to the configured API key.',
      inputSchema: {
        created_before: dateFilterSchema.describe(
          'Return notes created before this ISO 8601 date or date-time.',
        ),
        created_after: dateFilterSchema.describe(
          'Return notes created after this ISO 8601 date or date-time.',
        ),
        updated_after: dateFilterSchema.describe(
          'Return notes updated after this ISO 8601 date or date-time.',
        ),
        folder_id: z
          .string()
          .refine((value) => folderIdPattern.test(value), {
            message: 'Folder ID must match fol_ followed by 14 alphanumerics.',
          })
          .optional()
          .describe(
            'Return notes in this folder and its child folders. Use list_folders to discover IDs.',
          ),
        ...paginationSchema,
      },
      outputSchema: z.object({}).passthrough(),
      annotations: TOOL_ANNOTATIONS,
    },
    async ({
      created_before: createdBefore,
      created_after: createdAfter,
      updated_after: updatedAfter,
      folder_id: folderId,
      cursor,
      page_size: pageSize,
    }) => {
      const response = await granolaApiGetJson<ListNotesResponse>({
        config,
        path: 'v1/notes',
        query: {
          created_before: createdBefore,
          created_after: createdAfter,
          updated_after: updatedAfter,
          folder_id: folderId,
          cursor,
          page_size: pageSize,
        },
      });

      return toMcpToolResult(response);
    },
  );
}

function registerGetNoteTool(
  server: McpServer,
  config: McpConnectionGranolaConfig,
) {
  server.registerTool(
    'get_note',
    {
      title: 'Get Note',
      description:
        'Fetch a Granola note by ID, optionally including its transcript.',
      inputSchema: {
        note_id: z
          .string()
          .refine((value) => noteIdPattern.test(value), {
            message: 'Note ID must match not_ followed by 14 alphanumerics.',
          })
          .describe('The Granola note ID: not_ followed by 14 alphanumerics.'),
        include: z
          .literal('transcript')
          .optional()
          .describe('Set to transcript to include the note transcript.'),
      },
      outputSchema: z.object({}).passthrough(),
      annotations: TOOL_ANNOTATIONS,
    },
    async ({ note_id: noteId, include }) => {
      const note = await granolaApiGetJson<Record<string, unknown>>({
        config,
        path: `v1/notes/${encodeURIComponent(noteId)}`,
        query: { include },
      });

      return toMcpToolResult({ note });
    },
  );
}

function registerListFoldersTool(
  server: McpServer,
  config: McpConnectionGranolaConfig,
) {
  server.registerTool(
    'list_folders',
    {
      title: 'List Folders',
      description: 'List Granola folders available to the configured API key.',
      inputSchema: paginationSchema,
      outputSchema: z.object({}).passthrough(),
      annotations: TOOL_ANNOTATIONS,
    },
    async ({ cursor, page_size: pageSize }) => {
      const response = await granolaApiGetJson<ListFoldersResponse>({
        config,
        path: 'v1/folders',
        query: { cursor, page_size: pageSize },
      });

      return toMcpToolResult(response);
    },
  );
}

export function registerGranolaTools(
  server: McpServer,
  config: McpConnectionGranolaConfig,
) {
  registerListNotesTool(server, config);
  registerGetNoteTool(server, config);
  registerListFoldersTool(server, config);
}
