import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  fetchPublicUrl,
  SafeFetchViolationError,
} from '@roomote/sdk/server/safe-fetch';
import {
  PUBLIC_URL_FETCH_TOOL,
  publicUrlFetchInputSchema,
  type PublicUrlFetchResult,
} from '@roomote/types';

import { toolError } from './in-process-api';
import { toMcpToolResult } from './proxy-utils';

export class PublicUrlFetchToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublicUrlFetchToolError';
  }
}

function safeFetchErrorMessage(error: unknown): string {
  if (error instanceof SafeFetchViolationError) {
    if (
      error.message.startsWith('Public URL response') ||
      error.message.startsWith('Public URL exceeded') ||
      error.message.includes('default HTTP and HTTPS ports')
    ) {
      return error.message;
    }

    return 'URL was refused by Roomote public-destination policy.';
  }

  if (
    error instanceof Error &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  ) {
    return 'Public URL fetch timed out or was cancelled.';
  }

  return 'Public URL fetch failed.';
}

export async function executePublicUrlFetch(
  input: unknown,
  signal?: AbortSignal,
): Promise<PublicUrlFetchResult> {
  const parsed = publicUrlFetchInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new PublicUrlFetchToolError('A valid public URL is required.');
  }

  try {
    return await fetchPublicUrl(parsed.data.url, { signal });
  } catch (error) {
    throw new PublicUrlFetchToolError(safeFetchErrorMessage(error));
  }
}

export function registerRoomotePublicUrlFetchTool(server: McpServer): void {
  server.registerTool(
    PUBLIC_URL_FETCH_TOOL.name,
    {
      title: PUBLIC_URL_FETCH_TOOL.title,
      description: PUBLIC_URL_FETCH_TOOL.description,
      inputSchema: PUBLIC_URL_FETCH_TOOL.inputSchema,
      annotations: PUBLIC_URL_FETCH_TOOL.annotations,
    },
    async (input, extra) => {
      try {
        return toMcpToolResult({
          ...(await executePublicUrlFetch(input, extra.signal)),
        });
      } catch (error) {
        return toolError({
          error:
            error instanceof PublicUrlFetchToolError
              ? error.message
              : 'Public URL fetch failed.',
        });
      }
    },
  );
}
