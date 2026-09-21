import { sdk } from '@roomote/sdk/client';
import type { TaskIntegrationToolApprovals } from '@roomote/types';

import type { OpenCodeServerClient } from './client';
import type { OpenCodeToolPart } from './types';

const TOOL_APPROVAL_POLL_MS = 1_500;

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
export function createTaskToolApprovalRelay(options: {
  tools: TaskIntegrationToolApprovals['tools'];
  client: Pick<OpenCodeServerClient, 'message' | 'replyPermission'>;
  logger: { warn: (message: string) => void };
  signal: AbortSignal;
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
    const result = await api.request({
      ...tool,
      nativeRequestId: ask.requestId,
      args: await fetchCallArgs(ask),
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
