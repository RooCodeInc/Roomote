import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { sdk } from '@roomote/sdk/client';
import type { TaskIntegrationToolApprovals } from '@roomote/types';

import { parseDirectMcpConfig } from './mcp-config';

import type { OpenCodeServerClient } from './client';
import type { OpenCodeToolPart } from './types';

const TOOL_APPROVAL_POLL_MS = 1_500;
const AUTO_SERVER_TOOL_LIST_TIMEOUT_MS = 15_000;

type TaskToolApprovalApi = Pick<typeof sdk.toolApprovals, 'request' | 'status'>;

interface TaskToolApprovalAsk {
  requestId: string;
  sessionId: string;
  permission: string;
  messageId?: string;
  callId?: string;
}

/**
 * The native approval rules for this run, or undefined when there are none
 * (the `integrationToolApprovals` experiment is off, or the lookup failed).
 * Best effort: the integration proxy refuses a gated call without an
 * approval whatever the agent's own configuration says.
 */
export async function fetchTaskToolApprovals(logger: {
  warn: (message: string) => void;
}): Promise<TaskIntegrationToolApprovals | undefined> {
  try {
    const { toolApprovals } = await sdk.mcpConnections.getTaskToolApprovals();
    return toolApprovals ?? undefined;
  } catch (error) {
    logger.warn(
      `Could not load tool approval rules; gated tools will be refused: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return undefined;
  }
}

/**
 * Relays the agent's native `permission.asked` for a gated integration tool
 * to the Session owner and answers it with their decision. The task's Session
 * records the approval and shows the card; approving only lets the agent make
 * the call, and the integration proxy then claims that approval for the exact
 * arguments, so the relay never has to be trusted. Every failure rejects the
 * ask, so a turn is never left paused on a call nobody can resume.
 */
/** OpenCode's sanitization of one half of a `<server>_<tool>` key. */
const sanitizeNativeKeyPart = (value: string) =>
  value.replace(/[^a-zA-Z0-9_-]/g, '_');

async function listServerToolNames(server: {
  url: string;
  headers: Record<string, string>;
}): Promise<string[]> {
  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: { headers: server.headers },
  });
  const client = new Client({ name: 'roomote-task', version: '1.0.0' });
  await client.connect(transport);
  try {
    const result = await client.listTools(undefined, {
      timeout: AUTO_SERVER_TOOL_LIST_TIMEOUT_MS,
    });
    return result.tools.map((tool) => tool.name);
  } finally {
    await client.close().catch(() => undefined);
  }
}

/**
 * Which real tool each native key of an Auto-gated server stands for. Auto
 * mode gates a whole server with `<server>_*`, so an ask names only the
 * flattened key, and a flattened key is lossy (`run.query` and `run_query`
 * both ask as `run_query`). The server's own tool list is the only way back
 * to the real name, which the approval is recorded and claimed under. A key
 * two real tools share is left out, so an ask for it is refused rather than
 * recorded under the wrong tool; a server that cannot be listed is left out
 * the same way.
 */
export async function resolveAutoServerTools(input: {
  mcpServers: Record<string, unknown>;
  autoServers: string[];
  logger: { warn: (message: string) => void };
  listToolNames?: typeof listServerToolNames;
}): Promise<TaskIntegrationToolApprovals['tools']> {
  const listToolNames = input.listToolNames ?? listServerToolNames;
  const tools: TaskIntegrationToolApprovals['tools'] = {};
  await Promise.all(
    input.autoServers.map(async (serverName) => {
      const config = parseDirectMcpConfig(input.mcpServers[serverName]);
      if (config?.type !== 'streamable-http') return;
      let names: string[];
      try {
        names = await listToolNames(config);
      } catch (error) {
        input.logger.warn(
          `Could not list ${serverName} tools for Auto mode; its asks will be refused: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return;
      }
      const byKey = new Map<string, string[]>();
      for (const name of names) {
        const key = `${sanitizeNativeKeyPart(serverName)}_${sanitizeNativeKeyPart(name)}`;
        byKey.set(key, [...(byKey.get(key) ?? []), name]);
      }
      for (const [key, candidates] of byKey) {
        if (candidates.length === 1) {
          tools[key] = { integrationId: serverName, toolName: candidates[0]! };
        } else {
          input.logger.warn(
            `Tools ${candidates.join(', ')} of ${serverName} share the native key ${key}; asks for it will be refused.`,
          );
        }
      }
    }),
  );
  return tools;
}

export function createTaskToolApprovalRelay(options: {
  /** Every native key an ask may name, with the real tool behind it. */
  tools: TaskIntegrationToolApprovals['tools'];
  client: Pick<OpenCodeServerClient, 'message' | 'replyPermission'>;
  logger: { warn: (message: string) => void };
  signal: AbortSignal;
  /** What the user last asked for, shown to Auto mode's decision model. */
  getUserRequest?: () => string | undefined;
  api?: TaskToolApprovalApi;
  pollMs?: number;
  /** Pending asks keep a quiet turn from looking stalled. */
  onPendingCountChange?: (pending: number) => void;
}) {
  const api = options.api ?? sdk.toolApprovals;
  const pollMs = options.pollMs ?? TOOL_APPROVAL_POLL_MS;
  const handled = new Set<string>();
  let pending = 0;

  const reply = (
    ask: TaskToolApprovalAsk,
    response: 'once' | 'reject',
    message?: string,
  ) =>
    options.client.replyPermission({
      requestId: ask.requestId,
      reply: response,
      message,
      signal: options.signal,
    });

  const fetchCallArgs = async (ask: TaskToolApprovalAsk): Promise<unknown> => {
    if (!ask.messageId || !ask.callId) return undefined;
    const message = await options.client.message({
      sessionId: ask.sessionId,
      messageId: ask.messageId,
      signal: options.signal,
    });
    const part = message.parts.find(
      (candidate) =>
        candidate.type === 'tool' &&
        (candidate as OpenCodeToolPart).callID === ask.callId,
    ) as OpenCodeToolPart | undefined;
    return part?.state?.input;
  };

  const decide = async (ask: TaskToolApprovalAsk): Promise<void> => {
    const tool = options.tools[ask.permission];
    if (!tool) {
      await reply(
        ask,
        'reject',
        'This tool call could not be matched to a tool approval policy; the call was not run.',
      );
      return;
    }
    const userRequest = options.getUserRequest?.();
    const result = await api.request({
      ...tool,
      nativeRequestId: ask.requestId,
      args: await fetchCallArgs(ask),
      ...(userRequest ? { userRequest } : {}),
    });
    if (result.outcome === 'not_required' || result.outcome === 'approved') {
      await reply(ask, 'once');
      return;
    }
    if (result.outcome === 'unavailable') {
      await reply(
        ask,
        'reject',
        'This tool needs approval, and this task has nobody who can approve it; the call was not run.',
      );
      return;
    }
    for (;;) {
      if (options.signal.aborted) return;
      const { status } = await api.status(result.approvalId);
      if (status === 'approved') {
        await reply(ask, 'once');
        return;
      }
      if (status === 'expired') {
        await reply(
          ask,
          'reject',
          'The requester did not answer in time; the tool call was not run.',
        );
        return;
      }
      if (status !== 'pending') {
        await reply(ask, 'reject', 'The requester rejected this tool call.');
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  };

  /** Fire-and-forget from the event loop; the pause is the intended state. */
  const handleAsk = (ask: TaskToolApprovalAsk): void => {
    if (handled.has(ask.requestId)) return;
    handled.add(ask.requestId);
    options.onPendingCountChange?.(++pending);
    void decide(ask)
      .catch(async (error) => {
        options.logger.warn(
          `Tool approval relay failed for ${ask.permission}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        await reply(
          ask,
          'reject',
          'The approval for this tool call could not be completed.',
        ).catch(() => undefined);
      })
      .finally(() => options.onPendingCountChange?.(--pending));
  };

  return { handleAsk };
}
