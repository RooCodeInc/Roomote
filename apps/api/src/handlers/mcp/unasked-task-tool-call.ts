import { fingerprintIntegrationToolCall } from '@roomote/db/server';
import {
  INTEGRATION_TOOL_AUTO_PAUSED_AGENT_MESSAGE,
  describeIntegrationToolAutoAbsentDenial,
} from '@roomote/types';

import {
  claimProxyTaskToolCall,
  describeProxyToolApprovalBlock,
} from './tool-approval-enforcement';

const APPROVAL_POLL_MS = 1_500;
/**
 * Longer than an approval stays open, so a wait ends on the owner's decision
 * or on the approval expiring, never on this limit in normal operation.
 */
const APPROVAL_MAX_WAIT_MS = 12 * 60_000;

type UnaskedTaskToolCallDecision =
  | { allowed: true }
  | { allowed: false; message: string };

/**
 * Decide a task's gated call that arrived with no approval to claim.
 *
 * A task's agent normally asks before it calls a gated tool, and the proxy
 * claims that approval. The agent only asks about the tools that were gated
 * when its run started, so a tool gated since then (the session owner turned
 * Auto on, or set the tool to ask, while the task was running) is called
 * without asking. The proxy then asks on the task's behalf: the same
 * assessment and the same card, decided here before the call runs. The agent
 * waits on the call meanwhile, as it would on its own ask.
 *
 * A call made around the agent's own ask gets the same treatment, so it is
 * never a way past a decision.
 */
export async function decideUnaskedTaskToolCall(input: {
  runId: number | undefined;
  taskId: string | null;
  integrationId: string;
  /** The layer that governs a custom server's policies; see the enforcement. */
  policyScope?: 'deployment' | 'personal';
  toolName: string;
  args: unknown;
  resolveActingUserId: () => Promise<string | null>;
  /** This proxy endpoint and the caller's own token, to describe the tool. */
  endpoint?: { url: string; authorization: string | null };
  /** Stops the wait when the caller has gone away. */
  signal?: AbortSignal;
  pollMs?: number;
}): Promise<UnaskedTaskToolCallDecision> {
  const refused = {
    allowed: false as const,
    message: describeProxyToolApprovalBlock(input.toolName, 'needs_approval'),
  };
  const { runId, taskId } = input;
  if (runId === undefined || !taskId) return refused;
  const call = {
    taskId,
    integrationId: input.integrationId,
    toolName: input.toolName,
    args: input.args,
  };
  // Loaded on first use: asking pulls in the task approval code, which a
  // proxy request that has its approval never needs.
  const { getTaskToolApprovalStatus, requestTaskToolApproval } =
    await import('@roomote/sdk/server/task-tool-approvals');
  const proxy = resolveEndpointAccess(input.endpoint);
  const result = await requestTaskToolApproval({
    runId,
    integrationId: input.integrationId,
    toolName: input.toolName,
    // The same call asked again finds the card that is already open.
    nativeRequestId: `proxy:${fingerprintIntegrationToolCall({
      integrationId: input.integrationId,
      toolName: input.toolName,
      args: input.args ?? null,
    })}`,
    args: input.args,
    actingUserId: (await input.resolveActingUserId()) ?? undefined,
    resolveServers: async () => ({
      [input.integrationId]: {
        ...(input.endpoint ? { url: input.endpoint.url, headers: {} } : {}),
        ...(input.policyScope
          ? { toolApprovalPolicyScope: input.policyScope }
          : {}),
      },
    }),
    ...(proxy ? { integrationProxy: proxy } : {}),
  });

  // A caller that left while this was being decided gets nothing run for
  // it: no approval is claimed, and the call is not let through.
  const callerLeft = () => input.signal?.aborted === true;
  const claim = async (): Promise<UnaskedTaskToolCallDecision> => {
    if (callerLeft()) return refused;
    // One approval runs one call: with nothing left to claim, or a claim
    // that could not be made, the call does not run.
    return (await claimProxyTaskToolCall(call).catch(() => false))
      ? { allowed: true }
      : refused;
  };

  switch (result.outcome) {
    case 'not_required':
      return callerLeft() ? refused : { allowed: true };
    case 'approved':
      // Decided for this call just now, and left for the proxy to consume.
      return claim();
    case 'denied':
      return {
        allowed: false,
        message: describeIntegrationToolAutoAbsentDenial(result.reason),
      };
    case 'paused':
      return {
        allowed: false,
        message: INTEGRATION_TOOL_AUTO_PAUSED_AGENT_MESSAGE,
      };
    case 'unavailable':
      return {
        allowed: false,
        message:
          'This tool needs approval, and this task has nobody who can approve it; the call was not run.',
      };
    case 'pending':
      break;
  }

  const pollMs = input.pollMs ?? APPROVAL_POLL_MS;
  const deadline = Date.now() + APPROVAL_MAX_WAIT_MS;
  while (Date.now() < deadline) {
    if (callerLeft()) return refused;
    const status = await getTaskToolApprovalStatus({
      runId,
      approvalId: result.approvalId,
    });
    // The owner's approval is consumed here.
    if (status === 'approved') return claim();
    if (status === 'expired') {
      return {
        allowed: false,
        message:
          'The requester did not answer in time; the tool call was not run.',
      };
    }
    if (status !== 'pending') {
      return {
        allowed: false,
        message: 'The requester rejected this tool call.',
      };
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return refused;
}

/** The caller's token goes only to the endpoint it was sent to. */
function resolveEndpointAccess(
  endpoint: { url: string; authorization: string | null } | undefined,
): { origin: string; authorization: string } | undefined {
  if (!endpoint?.authorization) return undefined;
  try {
    return {
      origin: new URL(endpoint.url).origin,
      authorization: endpoint.authorization,
    };
  } catch {
    return undefined;
  }
}
