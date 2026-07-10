import { createRunToken } from '@roomote/auth';
import { httpBatchLink } from '@trpc/client';
import superjson from 'superjson';
import {
  createSandboxServerRpcClient,
  type SandboxServerRpcClient,
} from '../../../sandbox-router';

export type { SandboxServerRpcClient } from '../../../sandbox-router';

export const SANDBOX_SERVER_RPC_TIMEOUT_MS = 30_000;
export const SANDBOX_SERVER_RUN_TOKEN_TIMEOUT_MS = 15 * 60 * 1000;

type SandboxServerRpcFetch = (
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  signal: AbortSignal,
) => Promise<Response>;

interface WithSandboxServerRpcClientOptions<TResult> {
  runId: number;
  // Null mints a deployment-service-principal run token (Auth.createRunToken
  // accepts null) so automation-driven RPCs with no human user still run.
  userId: string | null;
  sandboxServerUrl: string;
  call: (client: SandboxServerRpcClient) => Promise<TResult>;
  fetch?: SandboxServerRpcFetch;
  timeoutMs?: number;
  runTokenTimeoutMs?: number;
}

export async function withSandboxServerRpcClient<TResult>({
  runId,
  userId,
  sandboxServerUrl,
  call,
  fetch: sandboxFetch,
  timeoutMs = SANDBOX_SERVER_RPC_TIMEOUT_MS,
  runTokenTimeoutMs = SANDBOX_SERVER_RUN_TOKEN_TIMEOUT_MS,
}: WithSandboxServerRpcClientOptions<TResult>): Promise<TResult> {
  const runToken = await createRunToken({
    runId,
    userId,
    timeoutMs: runTokenTimeoutMs,
  });

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const linkFetch: (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => Promise<Response> = (input, init) =>
      sandboxFetch
        ? sandboxFetch(input, init, controller.signal)
        : fetch(input, { ...init, signal: controller.signal });

    const client = createSandboxServerRpcClient({
      links: [
        httpBatchLink({
          url: `${sandboxServerUrl}/trpc`,
          transformer: superjson,
          headers: () => ({
            Authorization: `Bearer ${runToken}`,
          }),
          fetch: linkFetch,
        } as never),
      ],
    });

    return await call(client);
  } finally {
    clearTimeout(timeoutId);
  }
}
