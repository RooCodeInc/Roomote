import { httpBatchLink } from '@trpc/client';
import superjson from 'superjson';

import { createSandboxServerRpcClient } from '@roomote/sdk/sandbox-router';
import { SANDBOX_SERVER_PORT } from '@roomote/types';

import { errorResult, jsonResult } from './tool-result.js';
import type { RoomoteConfig, ToolResult } from './types.js';

// The sandbox server clones with a 300s per-attempt timeout and a few
// retries, so give the whole operation room before declaring it dead.
const CLONE_REPOSITORY_TIMEOUT_MS = 20 * 60 * 1000;

interface CloneRepositoryParams {
  repositoryFullName: string;
  branch?: string;
}

/**
 * Check out one of the deployment's repositories into the shared workspace.
 * Runs through the sandbox server in this same sandbox (which owns the
 * workspace manager, git credentials, and the repository manifest) rather
 * than the platform API, so a slow clone never holds a control-plane
 * request open.
 */
export async function handleCloneRepository(
  params: CloneRepositoryParams,
  config: RoomoteConfig,
  options: { sandboxServerUrl?: string; timeoutMs?: number } = {},
): Promise<ToolResult> {
  const repositoryFullName = params.repositoryFullName?.trim();
  const branch = params.branch?.trim();

  if (!repositoryFullName) {
    return errorResult('repositoryFullName is required (owner/repo)');
  }

  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? CLONE_REPOSITORY_TIMEOUT_MS;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const client = createSandboxServerRpcClient({
    links: [
      httpBatchLink({
        url: `${options.sandboxServerUrl ?? `http://127.0.0.1:${SANDBOX_SERVER_PORT}`}/trpc`,
        transformer: superjson,
        headers: () => ({ Authorization: `Bearer ${config.token}` }),
        fetch: (input: RequestInfo | URL, init?: RequestInit) =>
          fetch(input, { ...init, signal: controller.signal }),
      } as never),
    ],
  });

  try {
    const result = await client.commands.prepareRepository.mutate({
      repositoryFullName,
      ...(branch ? { branch } : {}),
    });

    return jsonResult({
      ...result,
      message: result.alreadyCheckedOut
        ? `${result.repositoryFullName} was already checked out at ${result.repositoryPath}; the working tree was left untouched.`
        : `${result.repositoryFullName} is checked out at ${result.repositoryPath}. Read its root AGENTS.md (if any) before working in it.`,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      return errorResult(
        `Checking out ${repositoryFullName} did not finish within ${Math.round(timeoutMs / 60_000)} minutes. Retry once; if it fails again, report the repository as unavailable instead of cloning it manually.`,
      );
    }

    return errorResult(
      `Failed to check out ${repositoryFullName}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  } finally {
    clearTimeout(timeoutId);
  }
}
