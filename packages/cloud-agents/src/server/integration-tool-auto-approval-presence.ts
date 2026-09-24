import { isSessionUserPresent } from '@roomote/redis';
import type { FastAgentSurface } from '@roomote/types';

const SESSION_PRESENCE_LOOKUP_TIMEOUT_MS = 2_000;

type AutoApprovalChatSurface = Extract<
  FastAgentSurface,
  'slack' | 'discord' | 'teams' | 'telegram'
>;

const AUTO_APPROVAL_CHAT_SURFACES = new Set([
  'slack',
  'discord',
  'teams',
  'telegram',
]);

/** Chat conversations can display an approval link without a browser lease. */
export function isAutoApprovalChatSurface(
  surface: string | null | undefined,
): surface is AutoApprovalChatSurface {
  return surface !== null && surface !== undefined
    ? AUTO_APPROVAL_CHAT_SURFACES.has(surface)
    : false;
}

/**
 * Resolve whether an Auto approval requester can answer a risky call. Chat
 * requesters are considered present; web presence is bounded, and lookup
 * errors or timeouts fail open to asking rather than denying the call.
 */
export async function isAutoApprovalRequesterPresent(input: {
  sessionId: string;
  userId: string;
  surface: string | null | undefined;
}): Promise<boolean> {
  if (isAutoApprovalChatSurface(input.surface)) return true;

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      isSessionUserPresent({
        sessionId: input.sessionId,
        userId: input.userId,
      }),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => {
          console.warn(
            `[Auto approvals] Presence lookup timed out for Session ${input.sessionId}; asking defensively.`,
          );
          resolve(true);
        }, SESSION_PRESENCE_LOOKUP_TIMEOUT_MS);
        timeout.unref?.();
      }),
    ]);
  } catch (error) {
    console.warn(
      `[Auto approvals] Presence lookup failed for Session ${input.sessionId}; asking defensively: ${error instanceof Error ? error.message : String(error)}`,
    );
    return true;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
