import {
  parseDiscordGatewayEvent,
  type DiscordGatewayEvent,
} from '@roomote/communication/discord-event';
import { getRedis } from '@roomote/redis';

const PENDING_ACCOUNT_LINK_TASK_PREFIX = 'discord:pending_account_link_task:';
const PENDING_ACCOUNT_LINK_TASK_TTL_SECONDS = 10 * 60;

const REMEMBER_PENDING_ACCOUNT_LINK_TASK_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if raw then
  local ok, current = pcall(cjson.decode, raw)
  if ok and type(current) == 'table' and type(current.receivedAt) == 'string' and type(current.eventId) == 'string' then
    local currentIsNewer = current.receivedAt > ARGV[1]
    if current.receivedAt == ARGV[1] then
      local currentIdIsNumeric = string.match(current.eventId, '^%d+$') ~= nil
      local incomingIdIsNumeric = string.match(ARGV[2], '^%d+$') ~= nil
      if currentIdIsNumeric and incomingIdIsNumeric and string.len(current.eventId) ~= string.len(ARGV[2]) then
        currentIsNewer = string.len(current.eventId) > string.len(ARGV[2])
      else
        currentIsNewer = current.eventId >= ARGV[2]
      end
    end
    if currentIsNewer then
      return 0
    end
  end
end
redis.call('SET', KEYS[1], ARGV[3], 'EX', ARGV[4])
return 1
`;

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
  await getRedis().eval(
    REMEMBER_PENDING_ACCOUNT_LINK_TASK_SCRIPT,
    1,
    pendingAccountLinkTaskKey(input.discordUserId),
    input.event.receivedAt,
    input.event.eventId,
    JSON.stringify(input.event),
    PENDING_ACCOUNT_LINK_TASK_TTL_SECONDS.toString(),
  );
}

export async function claimPendingDiscordAccountLinkTask(
  discordUserId: string,
): Promise<DiscordGatewayEvent | null> {
  return parsePendingAccountLinkTask(
    await getRedis().getdel(pendingAccountLinkTaskKey(discordUserId)),
  );
}
