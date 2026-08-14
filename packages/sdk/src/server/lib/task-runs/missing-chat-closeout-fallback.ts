import { getRedis } from '@roomote/redis';

const MISSING_CHAT_CLOSEOUT_FALLBACK_CLAIM_TTL_SECONDS = 7 * 24 * 60 * 60;
const MISSING_CHAT_CLOSEOUT_FALLBACK_CLAIM_KEY_PREFIX =
  'missing-chat-closeout-fallback:';

function getClaimKey(runId: number, completionId: string): string {
  return `${MISSING_CHAT_CLOSEOUT_FALLBACK_CLAIM_KEY_PREFIX}${runId}:${completionId}`;
}

export async function claimMissingChatCloseoutFallbackDelivery(input: {
  runId: number;
  completionId: string;
}): Promise<{ claimed: boolean }> {
  const claim = await getRedis().set(
    getClaimKey(input.runId, input.completionId),
    '1',
    'EX',
    MISSING_CHAT_CLOSEOUT_FALLBACK_CLAIM_TTL_SECONDS,
    'NX',
  );

  return { claimed: claim === 'OK' };
}

export async function releaseMissingChatCloseoutFallbackDelivery(input: {
  runId: number;
  completionId: string;
}): Promise<void> {
  await getRedis().del(getClaimKey(input.runId, input.completionId));
}
