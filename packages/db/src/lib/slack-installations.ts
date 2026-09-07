import { eq } from 'drizzle-orm';

import { db } from '../db';
import { slackInstallationChannels, slackInstallations } from '../schema';
import type { SlackInstallation } from '../types';

/**
 * Resolve a channel's sole recorded owner, only while that installation is active.
 * Ambiguous or inactive ownership fails closed. Only channels with no mappings
 * may fall back to the deployment's sole active installation for legacy settings.
 */
export async function findActiveSlackInstallationForChannel(
  channelId: string,
): Promise<SlackInstallation | null> {
  const mappings = await db.query.slackInstallationChannels.findMany({
    where: eq(slackInstallationChannels.channelId, channelId),
    with: { slackInstallation: true },
    limit: 2,
  });

  if (mappings.length > 0) {
    const owner = mappings[0]!.slackInstallation;
    return mappings.length === 1 && owner.isActive ? owner : null;
  }

  const active = await db.query.slackInstallations.findMany({
    where: eq(slackInstallations.isActive, true),
    limit: 2,
  });
  return active.length === 1 ? active[0]! : null;
}
