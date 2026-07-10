import { sdk } from '@roomote/sdk/client';

import type { HarnessLogger } from '../logging';
import type { IntegrationMcpOptions } from '../commands/setup/setup-mcps';

type UserMcpServers = NonNullable<IntegrationMcpOptions['userMcpServers']>;

interface ActorScopedIntegrationSnapshot {
  userMcpServers?: UserMcpServers;
}

interface FetchActorScopedSnapshotResult {
  snapshot: ActorScopedIntegrationSnapshot;
  didFail: boolean;
}

interface CreateActorScopedMcpRefresherOptions {
  cloudJob: {
    id: number;
    actingUserId?: string | null;
  };
  integrations: IntegrationMcpOptions;
  requestReconnect?: (options: {
    reason: string;
    afterCurrentTurn?: boolean;
  }) => Promise<void>;
  logger: HarnessLogger;
}

interface RefreshActorScopedMcpOptions {
  deferReconnectUntilTurnBoundary?: boolean;
  skipReconnect?: boolean;
}

export interface RefreshActorScopedMcpResult {
  didChange: boolean;
  didFail: boolean;
  didReconnect: boolean;
  actorChanged: boolean;
  reason?: string;
}

function normalizeHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!headers) {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(headers).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
}

function normalizeUserMcpServers(
  servers: UserMcpServers | undefined,
): UserMcpServers | undefined {
  if (!servers || Object.keys(servers).length === 0) {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(servers)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [
        key,
        {
          url: value.url,
          ...(value.headers
            ? { headers: normalizeHeaders(value.headers) }
            : {}),
        },
      ]),
  );
}

function snapshotFromIntegrations(
  integrations: IntegrationMcpOptions,
): ActorScopedIntegrationSnapshot {
  return {
    ...(integrations.userMcpServers
      ? {
          userMcpServers: normalizeUserMcpServers(integrations.userMcpServers),
        }
      : {}),
  };
}

function snapshotsEqual(
  left: ActorScopedIntegrationSnapshot,
  right: ActorScopedIntegrationSnapshot,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function fetchActorScopedSnapshot(
  currentSnapshot: ActorScopedIntegrationSnapshot,
  logger: HarnessLogger,
): Promise<FetchActorScopedSnapshotResult> {
  const nextSnapshot: ActorScopedIntegrationSnapshot = { ...currentSnapshot };
  let didFail = false;

  try {
    const { servers } = await sdk.mcpConnections.getMcpServerConfigs();
    const normalizedServers = normalizeUserMcpServers(servers);

    if (normalizedServers) {
      nextSnapshot.userMcpServers = normalizedServers;
    } else {
      delete nextSnapshot.userMcpServers;
    }
  } catch (error) {
    didFail = true;
    logger.warn(
      `[actorScopedMcpRefresh] Failed to refresh user MCP servers: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  return {
    snapshot: nextSnapshot,
    didFail,
  };
}

function applySnapshotToIntegrations(
  integrations: IntegrationMcpOptions,
  snapshot: ActorScopedIntegrationSnapshot,
): void {
  if (snapshot.userMcpServers) {
    integrations.userMcpServers = snapshot.userMcpServers;
  } else {
    delete integrations.userMcpServers;
  }
}

export function createActorScopedMcpRefresher({
  cloudJob,
  integrations,
  requestReconnect,
  logger,
}: CreateActorScopedMcpRefresherOptions) {
  let mountedActorUserId = cloudJob.actingUserId ?? null;
  let mountedSnapshot = snapshotFromIntegrations(integrations);

  return async function refreshActorScopedMcpForUser(
    targetActorUserId?: string | null,
    options?: RefreshActorScopedMcpOptions,
  ): Promise<RefreshActorScopedMcpResult> {
    const nextActorUserId = targetActorUserId?.trim() || null;
    const actorChanged = nextActorUserId !== mountedActorUserId;

    if (!nextActorUserId) {
      return {
        didChange: false,
        didFail: false,
        didReconnect: false,
        actorChanged: false,
      };
    }

    logger.info(
      actorChanged
        ? `[actorScopedMcpRefresh] Refreshing actor-scoped MCP state: ${mountedActorUserId ?? 'none'} -> ${nextActorUserId} (deferReconnect=${options?.deferReconnectUntilTurnBoundary === true})`
        : `[actorScopedMcpRefresh] Rechecking actor-scoped MCP state for ${nextActorUserId} (deferReconnect=${options?.deferReconnectUntilTurnBoundary === true})`,
    );

    const { snapshot: nextSnapshot, didFail } = await fetchActorScopedSnapshot(
      mountedSnapshot,
      logger,
    );

    if (didFail) {
      logger.warn(
        `[actorScopedMcpRefresh] Snapshot refresh failed for actor ${nextActorUserId}; leaving current MCP state mounted`,
      );
      return {
        didChange: false,
        didFail: true,
        didReconnect: false,
        actorChanged,
      };
    }

    if (actorChanged) {
      mountedActorUserId = nextActorUserId;
    }

    if (snapshotsEqual(mountedSnapshot, nextSnapshot)) {
      logger.info(
        actorChanged
          ? `[actorScopedMcpRefresh] Actor changed to ${nextActorUserId}, but MCP snapshot is unchanged`
          : `[actorScopedMcpRefresh] Actor ${nextActorUserId} MCP snapshot is unchanged`,
      );
      return {
        didChange: false,
        didFail: false,
        didReconnect: false,
        actorChanged,
      };
    }

    mountedSnapshot = nextSnapshot;
    applySnapshotToIntegrations(integrations, nextSnapshot);

    const reason = `actor-scoped MCP refresh for ${nextActorUserId}`;
    const afterCurrentTurn = options?.deferReconnectUntilTurnBoundary === true;

    if (options?.skipReconnect) {
      logger.info(
        `[actorScopedMcpRefresh] MCP snapshot changed for actor ${nextActorUserId}; reconnect will be handled by the caller`,
      );
      return {
        didChange: true,
        didFail: false,
        didReconnect: false,
        actorChanged,
        reason,
      };
    }

    logger.info(
      `[actorScopedMcpRefresh] MCP snapshot changed for actor ${nextActorUserId}; requesting ${afterCurrentTurn ? 'deferred' : 'immediate'} reconnect`,
    );

    await requestReconnect?.({
      reason,
      afterCurrentTurn,
    });

    return {
      didChange: true,
      didFail: false,
      didReconnect: Boolean(requestReconnect),
      actorChanged,
      reason,
    };
  };
}
