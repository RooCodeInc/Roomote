import { httpBatchLink } from '@trpc/client';
import superjson from 'superjson';

import { createSandboxServerRpcClient } from '@roomote/sdk/sandbox-router';
import { SANDBOX_SERVER_PORT } from '@roomote/types';

import { errorResult, jsonResult } from './tool-result.js';
import type { RoomoteConfig, ToolResult } from './types.js';

const LIST_REPOSITORIES_TIMEOUT_MS = 60_000;

interface ListRepositoriesParams {
  query?: string | null;
  offset?: number | null;
  limit?: number | null;
}

/**
 * List the repositories this task may check out. Runs through the sandbox
 * server in this same sandbox, which owns the run's repository scope and the
 * checkout state, so the answer always matches what `clone_repository` allows.
 */
export async function handleListRepositories(
  params: ListRepositoriesParams,
  config: RoomoteConfig,
  options: { sandboxServerUrl?: string; timeoutMs?: number } = {},
): Promise<ToolResult> {
  const query = params.query?.trim();
  const client = createSandboxServerRpcClient({
    links: [
      httpBatchLink({
        url: `${options.sandboxServerUrl ?? `http://127.0.0.1:${SANDBOX_SERVER_PORT}`}/trpc`,
        transformer: superjson,
        headers: () => ({ Authorization: `Bearer ${config.token}` }),
        fetch: (input: RequestInfo | URL, init?: RequestInit) =>
          fetch(input, {
            ...init,
            signal: AbortSignal.timeout(
              options.timeoutMs ?? LIST_REPOSITORIES_TIMEOUT_MS,
            ),
          }),
      } as never),
    ],
  });

  try {
    // Models that fill every optional argument send null for the unused ones.
    return jsonResult(
      await client.commands.listRepositories.query({
        ...(query ? { query } : {}),
        ...(params.offset ? { offset: params.offset } : {}),
        ...(params.limit ? { limit: params.limit } : {}),
      }),
    );
  } catch (error) {
    return errorResult(
      `Failed to list repositories: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
