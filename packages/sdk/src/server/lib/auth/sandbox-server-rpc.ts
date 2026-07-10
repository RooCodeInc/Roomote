import { createJobToken } from '@roomote/auth';
import { httpBatchLink } from '@trpc/client';
import superjson from 'superjson';
import {
  createSandboxServerRpcClient,
  type SandboxServerRpcClient,
} from '../../../sandbox-router';

export type { SandboxServerRpcClient } from '../../../sandbox-router';

export const SANDBOX_SERVER_RPC_TIMEOUT_MS = 30_000;
export const SANDBOX_SERVER_JOB_TOKEN_TIMEOUT_MS = 15 * 60 * 1000;

type SandboxServerRpcFetch = (
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  signal: AbortSignal,
) => Promise<Response>;

interface WithSandboxServerRpcClientOptions<TResult> {
  cloudJobId: number;
  // Null mints a deployment-service-principal job token (Auth.createJobToken
  // accepts null) so automation-driven RPCs with no human user still run.
  userId: string | null;
  sandboxServerUrl: string;
  call: (client: SandboxServerRpcClient) => Promise<TResult>;
  fetch?: SandboxServerRpcFetch;
  timeoutMs?: number;
  jobTokenTimeoutMs?: number;
}

export async function withSandboxServerRpcClient<TResult>({
  cloudJobId,
  userId,
  sandboxServerUrl,
  call,
  fetch: sandboxFetch,
  timeoutMs = SANDBOX_SERVER_RPC_TIMEOUT_MS,
  jobTokenTimeoutMs = SANDBOX_SERVER_JOB_TOKEN_TIMEOUT_MS,
}: WithSandboxServerRpcClientOptions<TResult>): Promise<TResult> {
  const jobToken = await createJobToken({
    cloudJobId,
    userId,
    timeoutMs: jobTokenTimeoutMs,
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
            Authorization: `Bearer ${jobToken}`,
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
