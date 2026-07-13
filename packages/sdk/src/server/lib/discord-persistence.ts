import {
  and,
  db,
  desc,
  discordGatewaySessions,
  discordInstallationChannels,
  discordInstallations,
  discordUserMappings,
  eq,
  isNull,
  users,
} from '@roomote/db/server';

export type DiscordInstallationUpsert = {
  guildId: string;
  guildName?: string | null;
  applicationId: string;
  botUserId: string;
  installedByUserId?: string | null;
  isActive?: boolean;
  seenAt?: Date;
};

export type DiscordInstallationReconciliationInput = {
  applicationId: string;
  botUserId: string;
  installedByUserId?: string | null;
  guilds: Array<{
    guildId: string;
    guildName?: string | null;
  }>;
  seenAt?: Date;
};

export type DiscordInstallationReconciliationResult = {
  activeGuildCount: number;
  deactivatedGuildIds: string[];
  resetGuildIds: string[];
};

export type DiscordInstallationChannelInput = {
  channelId: string;
  channelName?: string | null;
  channelType: number;
  parentId?: string | null;
  position?: number | null;
  permissions?: string | null;
};

export type DiscordDefaultDestination = {
  installationId: string;
  guildId: string;
  guildName: string | null;
  channelId: string;
  channelName: string | null;
  channelType: number;
};

export async function upsertDiscordInstallation(
  input: DiscordInstallationUpsert,
) {
  const now = input.seenAt ?? new Date();
  const installation = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({
        id: discordInstallations.id,
        applicationId: discordInstallations.applicationId,
        botUserId: discordInstallations.botUserId,
      })
      .from(discordInstallations)
      .where(eq(discordInstallations.guildId, input.guildId))
      .limit(1);
    const identityChanged =
      existing !== undefined &&
      (existing.applicationId !== input.applicationId ||
        existing.botUserId !== input.botUserId);
    const [upserted] = await tx
      .insert(discordInstallations)
      .values({
        guildId: input.guildId,
        guildName: input.guildName ?? null,
        applicationId: input.applicationId,
        botUserId: input.botUserId,
        installedByUserId: input.installedByUserId ?? null,
        isActive: input.isActive ?? true,
        lastSeenAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: discordInstallations.guildId,
        set: {
          guildName: input.guildName ?? null,
          applicationId: input.applicationId,
          botUserId: input.botUserId,
          ...(input.installedByUserId !== undefined
            ? { installedByUserId: input.installedByUserId }
            : {}),
          isActive: input.isActive ?? true,
          lastSeenAt: now,
          ...(identityChanged
            ? {
                defaultChannelId: null,
                defaultChannelName: null,
                defaultChannelType: null,
                lastUsedAt: null,
              }
            : {}),
          updatedAt: now,
        },
      })
      .returning();

    if (identityChanged && existing) {
      await tx
        .update(discordInstallationChannels)
        .set({ isAvailable: false, updatedAt: now })
        .where(
          eq(discordInstallationChannels.discordInstallationId, existing.id),
        );
    }

    return upserted;
  });

  if (!installation) {
    throw new Error(`Failed to persist Discord guild ${input.guildId}.`);
  }

  return installation;
}

export async function findDiscordInstallationByGuildId(guildId: string) {
  return (
    (await db.query.discordInstallations.findFirst({
      where: eq(discordInstallations.guildId, guildId),
    })) ?? null
  );
}

export async function listDiscordInstallations(options?: {
  includeInactive?: boolean;
}) {
  return db.query.discordInstallations.findMany({
    where: options?.includeInactive
      ? undefined
      : eq(discordInstallations.isActive, true),
    orderBy: [desc(discordInstallations.lastSeenAt)],
  });
}

export async function deactivateDiscordInstallation(
  guildId: string,
  at = new Date(),
): Promise<boolean> {
  const rows = await db
    .update(discordInstallations)
    .set({ isActive: false, updatedAt: at })
    .where(eq(discordInstallations.guildId, guildId))
    .returning({ id: discordInstallations.id });

  return rows.length > 0;
}

/**
 * Reconcile the persisted installation catalog against Discord's live guild
 * list for the currently configured bot identity.
 *
 * Guilds that disappear are deactivated, and a later live observation
 * reactivates them. A bot/application rotation also invalidates every default
 * destination and cached channel snapshot owned by the previous identity so
 * proactive work cannot be delivered through stale configuration.
 */
export async function reconcileDiscordInstallations(
  input: DiscordInstallationReconciliationInput,
): Promise<DiscordInstallationReconciliationResult> {
  const seenAt = input.seenAt ?? new Date();
  const liveGuilds = new Map(
    input.guilds.map((guild) => [guild.guildId, guild] as const),
  );
  const deactivatedGuildIds: string[] = [];
  const resetGuildIds: string[] = [];

  await db.transaction(async (tx) => {
    const existingInstallations = await tx.select().from(discordInstallations);
    const existingByGuildId = new Map(
      existingInstallations.map((installation) => [
        installation.guildId,
        installation,
      ]),
    );

    for (const installation of existingInstallations) {
      const liveGuild = liveGuilds.get(installation.guildId);
      const identityChanged =
        installation.applicationId !== input.applicationId ||
        installation.botUserId !== input.botUserId;

      if (!liveGuild && installation.isActive) {
        deactivatedGuildIds.push(installation.guildId);
      }
      if (identityChanged) {
        resetGuildIds.push(installation.guildId);
      }

      await tx
        .update(discordInstallations)
        .set({
          applicationId: input.applicationId,
          botUserId: input.botUserId,
          ...(liveGuild
            ? {
                guildName: liveGuild.guildName ?? null,
                ...(input.installedByUserId !== undefined
                  ? { installedByUserId: input.installedByUserId }
                  : {}),
                isActive: true,
                lastSeenAt: seenAt,
              }
            : { isActive: false }),
          ...(identityChanged
            ? {
                defaultChannelId: null,
                defaultChannelName: null,
                defaultChannelType: null,
                lastUsedAt: null,
              }
            : {}),
          updatedAt: seenAt,
        })
        .where(eq(discordInstallations.id, installation.id));

      if (identityChanged) {
        await tx
          .update(discordInstallationChannels)
          .set({ isAvailable: false, updatedAt: seenAt })
          .where(
            eq(
              discordInstallationChannels.discordInstallationId,
              installation.id,
            ),
          );
      }
    }

    for (const guild of liveGuilds.values()) {
      if (existingByGuildId.has(guild.guildId)) {
        continue;
      }

      await tx.insert(discordInstallations).values({
        guildId: guild.guildId,
        guildName: guild.guildName ?? null,
        applicationId: input.applicationId,
        botUserId: input.botUserId,
        installedByUserId: input.installedByUserId ?? null,
        isActive: true,
        lastSeenAt: seenAt,
        updatedAt: seenAt,
      });
    }
  });

  return {
    activeGuildCount: liveGuilds.size,
    deactivatedGuildIds,
    resetGuildIds,
  };
}

/**
 * Replace the visible-channel snapshot for a guild without deleting old rows.
 * Keeping unavailable rows makes a temporarily missing permission distinguishable
 * from a never-seen destination and preserves the selected channel metadata.
 */
export async function syncDiscordInstallationChannels(input: {
  guildId: string;
  channels: DiscordInstallationChannelInput[];
  seenAt?: Date;
}): Promise<void> {
  const installation = await findDiscordInstallationByGuildId(input.guildId);
  if (!installation) {
    throw new Error(`Discord guild ${input.guildId} is not installed.`);
  }

  const seenAt = input.seenAt ?? new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(discordInstallationChannels)
      .set({ isAvailable: false, updatedAt: seenAt })
      .where(
        eq(discordInstallationChannels.discordInstallationId, installation.id),
      );

    for (const channel of input.channels) {
      await tx
        .insert(discordInstallationChannels)
        .values({
          discordInstallationId: installation.id,
          channelId: channel.channelId,
          channelName: channel.channelName ?? null,
          channelType: channel.channelType,
          parentId: channel.parentId ?? null,
          position: channel.position ?? null,
          permissions: channel.permissions ?? null,
          isAvailable: true,
          lastSeenAt: seenAt,
          updatedAt: seenAt,
        })
        .onConflictDoUpdate({
          target: [
            discordInstallationChannels.discordInstallationId,
            discordInstallationChannels.channelId,
          ],
          set: {
            channelName: channel.channelName ?? null,
            channelType: channel.channelType,
            parentId: channel.parentId ?? null,
            position: channel.position ?? null,
            permissions: channel.permissions ?? null,
            isAvailable: true,
            lastSeenAt: seenAt,
            updatedAt: seenAt,
          },
        });
    }
  });
}

export async function listDiscordInstallationChannels(input: {
  guildId: string;
  includeUnavailable?: boolean;
}) {
  const installation = await findDiscordInstallationByGuildId(input.guildId);
  if (!installation) {
    return [];
  }

  return db.query.discordInstallationChannels.findMany({
    where: input.includeUnavailable
      ? eq(discordInstallationChannels.discordInstallationId, installation.id)
      : and(
          eq(
            discordInstallationChannels.discordInstallationId,
            installation.id,
          ),
          eq(discordInstallationChannels.isAvailable, true),
        ),
    orderBy: [
      discordInstallationChannels.position,
      discordInstallationChannels.channelName,
    ],
  });
}

/** Record a selected destination and ensure it exists in the channel catalog. */
export async function captureDiscordDefaultDestination(input: {
  guildId: string;
  channelId: string;
  channelName?: string | null;
  channelType: number;
  selectedAt?: Date;
}): Promise<DiscordDefaultDestination> {
  const installation = await findDiscordInstallationByGuildId(input.guildId);
  if (!installation) {
    throw new Error(`Discord guild ${input.guildId} is not installed.`);
  }

  const selectedAt = input.selectedAt ?? new Date();
  await db.transaction(async (tx) => {
    await tx
      .insert(discordInstallationChannels)
      .values({
        discordInstallationId: installation.id,
        channelId: input.channelId,
        channelName: input.channelName ?? null,
        channelType: input.channelType,
        isAvailable: true,
        lastSeenAt: selectedAt,
        updatedAt: selectedAt,
      })
      .onConflictDoUpdate({
        target: [
          discordInstallationChannels.discordInstallationId,
          discordInstallationChannels.channelId,
        ],
        set: {
          channelName: input.channelName ?? null,
          channelType: input.channelType,
          isAvailable: true,
          lastSeenAt: selectedAt,
          updatedAt: selectedAt,
        },
      });

    await tx
      .update(discordInstallations)
      .set({
        defaultChannelId: input.channelId,
        defaultChannelName: input.channelName ?? null,
        defaultChannelType: input.channelType,
        lastUsedAt: selectedAt,
        updatedAt: selectedAt,
      })
      .where(eq(discordInstallations.id, installation.id));
  });

  return {
    installationId: installation.id,
    guildId: installation.guildId,
    guildName: installation.guildName,
    channelId: input.channelId,
    channelName: input.channelName ?? null,
    channelType: input.channelType,
  };
}

/**
 * Find a guild's selected destination, or the most recently used active one
 * when proactive automation output is not scoped to a particular guild.
 */
export async function findDiscordDefaultDestination(
  guildId?: string,
): Promise<DiscordDefaultDestination | null> {
  const [destination] = await db
    .select({
      installationId: discordInstallations.id,
      guildId: discordInstallations.guildId,
      guildName: discordInstallations.guildName,
      channelId: discordInstallationChannels.channelId,
      channelName: discordInstallationChannels.channelName,
      channelType: discordInstallationChannels.channelType,
    })
    .from(discordInstallations)
    .innerJoin(
      discordInstallationChannels,
      and(
        eq(
          discordInstallationChannels.discordInstallationId,
          discordInstallations.id,
        ),
        eq(
          discordInstallationChannels.channelId,
          discordInstallations.defaultChannelId,
        ),
        eq(discordInstallationChannels.isAvailable, true),
      ),
    )
    .where(
      guildId
        ? and(
            eq(discordInstallations.isActive, true),
            eq(discordInstallations.guildId, guildId),
          )
        : eq(discordInstallations.isActive, true),
    )
    .orderBy(desc(discordInstallations.lastUsedAt))
    .limit(1);

  if (!destination) {
    return null;
  }

  return destination;
}

export async function upsertDiscordUserMapping(input: {
  discordUserId: string;
  discordUsername?: string | null;
  discordGlobalName?: string | null;
  discordDmChannelId?: string | null;
  userId: string;
}) {
  const now = new Date();
  const [mapping] = await db
    .insert(discordUserMappings)
    .values({
      discordUserId: input.discordUserId,
      discordUsername: input.discordUsername ?? null,
      discordGlobalName: input.discordGlobalName ?? null,
      discordDmChannelId: input.discordDmChannelId ?? null,
      userId: input.userId,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: discordUserMappings.discordUserId,
      set: {
        discordUsername: input.discordUsername ?? null,
        discordGlobalName: input.discordGlobalName ?? null,
        ...(input.discordDmChannelId !== undefined
          ? { discordDmChannelId: input.discordDmChannelId }
          : {}),
        userId: input.userId,
        updatedAt: now,
      },
    })
    .returning();

  if (!mapping) {
    throw new Error(`Failed to link Discord user ${input.discordUserId}.`);
  }

  return mapping;
}

export async function findDiscordMappedUserId(
  discordUserId: string | null | undefined,
): Promise<string | null> {
  if (!discordUserId) {
    return null;
  }

  const [mapping] = await db
    .select({ userId: discordUserMappings.userId })
    .from(discordUserMappings)
    .innerJoin(
      users,
      and(eq(users.id, discordUserMappings.userId), isNull(users.deletedAt)),
    )
    .where(eq(discordUserMappings.discordUserId, discordUserId))
    .limit(1);

  return mapping?.userId ?? null;
}

export async function findDiscordUserMappingByRoomoteUserId(userId: string) {
  return (
    (await db.query.discordUserMappings.findFirst({
      where: eq(discordUserMappings.userId, userId),
      orderBy: [desc(discordUserMappings.updatedAt)],
    })) ?? null
  );
}

export type DiscordGatewayResumeState = {
  sessionId: string;
  resumeGatewayUrl: string;
  sequence: number;
  shardId: number;
  shardCount: number;
};

export type DiscordGatewaySessionKey = {
  tokenFingerprint: string;
  shardId: number;
};

function discordGatewaySessionRowId(input: DiscordGatewaySessionKey): string {
  return `${input.tokenFingerprint}:${input.shardId}`;
}

export async function findDiscordGatewayResumeState(
  input: DiscordGatewaySessionKey,
): Promise<DiscordGatewayResumeState | null> {
  const state = await db.query.discordGatewaySessions.findFirst({
    where: eq(discordGatewaySessions.id, discordGatewaySessionRowId(input)),
  });
  if (
    !state?.sessionId ||
    !state.resumeGatewayUrl ||
    state.sequence === null ||
    state.shardCount === null
  ) {
    return null;
  }

  return {
    sessionId: state.sessionId,
    resumeGatewayUrl: state.resumeGatewayUrl,
    sequence: state.sequence,
    shardId: input.shardId,
    shardCount: state.shardCount,
  };
}

export async function saveDiscordGatewayResumeState(
  input: DiscordGatewaySessionKey & {
    sessionId: string;
    resumeGatewayUrl: string;
    sequence: number;
    shardCount: number;
    connectedAt?: Date;
  },
): Promise<void> {
  const now = input.connectedAt ?? new Date();
  await db
    .insert(discordGatewaySessions)
    .values({
      id: discordGatewaySessionRowId(input),
      sessionId: input.sessionId,
      resumeGatewayUrl: input.resumeGatewayUrl,
      sequence: input.sequence,
      shardCount: input.shardCount,
      lastConnectedAt: now,
      disconnectedAt: null,
      lastError: null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: discordGatewaySessions.id,
      set: {
        sessionId: input.sessionId,
        resumeGatewayUrl: input.resumeGatewayUrl,
        sequence: input.sequence,
        shardCount: input.shardCount,
        lastConnectedAt: now,
        disconnectedAt: null,
        lastError: null,
        updatedAt: now,
      },
    });
}

export async function updateDiscordGatewaySequence(
  input: DiscordGatewaySessionKey & {
    sequence: number;
    updatedAt?: Date;
  },
): Promise<void> {
  await db
    .update(discordGatewaySessions)
    .set({ sequence: input.sequence, updatedAt: input.updatedAt ?? new Date() })
    .where(eq(discordGatewaySessions.id, discordGatewaySessionRowId(input)));
}

export async function recordDiscordGatewayHeartbeatAck(
  input: DiscordGatewaySessionKey & { acknowledgedAt?: Date },
): Promise<void> {
  const acknowledgedAt = input.acknowledgedAt ?? new Date();
  await db
    .update(discordGatewaySessions)
    .set({
      lastHeartbeatAckAt: acknowledgedAt,
      updatedAt: acknowledgedAt,
    })
    .where(eq(discordGatewaySessions.id, discordGatewaySessionRowId(input)));
}

export async function clearDiscordGatewayResumeState(
  input: DiscordGatewaySessionKey & {
    disconnectedAt?: Date;
    lastError?: string | null;
  },
): Promise<void> {
  const disconnectedAt = input.disconnectedAt ?? new Date();
  await db
    .insert(discordGatewaySessions)
    .values({
      id: discordGatewaySessionRowId(input),
      disconnectedAt,
      lastError: input.lastError ?? null,
      updatedAt: disconnectedAt,
    })
    .onConflictDoUpdate({
      target: discordGatewaySessions.id,
      set: {
        sessionId: null,
        resumeGatewayUrl: null,
        sequence: null,
        shardCount: null,
        disconnectedAt,
        lastError: input.lastError ?? null,
        updatedAt: disconnectedAt,
      },
    });
}
