import {
  parseDiscordGatewayEvent,
  type DiscordGatewayEvent,
} from '@roomote/communication/discord-event';
import { getRedis } from '@roomote/redis';

const PENDING_ACCOUNT_LINK_TASK_PREFIX = 'discord:pending_account_link_task:';
const PENDING_ACCOUNT_LINK_TASK_TTL_SECONDS = 10 * 60;

function pendingAccountLinkTaskKey(discordUserId: string): string {
  return `${PENDING_ACCOUNT_LINK_TASK_PREFIX}${discordUserId}`;
}

function parsePendingAccountLinkTask(value: string | null) {
  if (!value) return null;
  try {
    const parsed = parseDiscordGatewayEvent(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function rememberPendingDiscordAccountLinkTask(input: {
  discordUserId: string;
  event: DiscordGatewayEvent;
}): Promise<void> {
  await getRedis().set(
    pendingAccountLinkTaskKey(input.discordUserId),
    JSON.stringify(input.event),
    'EX',
    PENDING_ACCOUNT_LINK_TASK_TTL_SECONDS,
  );
}

export async function claimPendingDiscordAccountLinkTask(
  discordUserId: string,
): Promise<DiscordGatewayEvent | null> {
  return parsePendingAccountLinkTask(
    await getRedis().getdel(pendingAccountLinkTaskKey(discordUserId)),
  );
}
