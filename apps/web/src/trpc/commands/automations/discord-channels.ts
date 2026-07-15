import {
  and,
  asc,
  db,
  discordInstallationChannels,
  discordInstallations,
  eq,
  inArray,
} from '@roomote/db/server';

import type { UserAuthSuccess } from '@/types';

import { assertAdmin } from './feature-gates';
import type { AutomationDiscordChannelOption } from './types';

// Text (0) and announcement (5) channels only: automation reports are plain
// channel messages, which forum-style channels cannot accept.
const AUTOMATION_DISCORD_CHANNEL_TYPES = [0, 5];

/**
 * DB-only read of the Discord channels the automations destination picker can
 * target: available channels of active installations, from the cached channel
 * catalog (no live Discord API call).
 */
export async function listAutomationDiscordChannelsCommand(
  auth: UserAuthSuccess,
): Promise<{ channels: AutomationDiscordChannelOption[] }> {
  assertAdmin(auth);

  const rows = await db
    .select({
      channelId: discordInstallationChannels.channelId,
      channelName: discordInstallationChannels.channelName,
      guildId: discordInstallations.guildId,
      guildName: discordInstallations.guildName,
    })
    .from(discordInstallationChannels)
    .innerJoin(
      discordInstallations,
      eq(
        discordInstallationChannels.discordInstallationId,
        discordInstallations.id,
      ),
    )
    .where(
      and(
        eq(discordInstallations.isActive, true),
        eq(discordInstallationChannels.isAvailable, true),
        inArray(
          discordInstallationChannels.channelType,
          AUTOMATION_DISCORD_CHANNEL_TYPES,
        ),
      ),
    )
    .orderBy(
      asc(discordInstallations.guildName),
      asc(discordInstallationChannels.position),
      asc(discordInstallationChannels.channelName),
    );

  const activeGuildCount = new Set(rows.map((row) => row.guildId)).size;

  return {
    channels: rows.map((row) => {
      const name = row.channelName ?? row.channelId;

      return {
        id: row.channelId,
        name,
        // Disambiguate by guild only when several guilds are installed.
        label:
          activeGuildCount > 1 && row.guildName
            ? `#${name} — ${row.guildName}`
            : `#${name}`,
        guildId: row.guildId,
        guildName: row.guildName,
      };
    }),
  };
}
