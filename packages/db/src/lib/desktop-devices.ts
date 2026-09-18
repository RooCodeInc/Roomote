import type {
  DesktopDeviceAction,
  DesktopDeviceAuditEvent,
  DesktopDeviceAuditOutcome,
} from '@roomote/types';
import { isRoomoteDeploymentDisabled } from '@roomote/types';

import { and, desc, eq, isNull } from 'drizzle-orm';

import { db } from '../db';
import {
  deploymentSettings,
  desktopDeviceAudit,
  desktopDevices,
  users,
} from '../schema';

export async function registerDesktopDevice(input: {
  id: string;
  ownerUserId: string;
  name: string;
  platform: string;
  capabilities: DesktopDeviceAction[];
  protocolVersion: number;
  instanceId: string;
}): Promise<'connected' | 'owner_mismatch' | 'revoked'> {
  const existing = await db.query.desktopDevices.findFirst({
    where: eq(desktopDevices.id, input.id),
    columns: { ownerUserId: true, revokedAt: true },
  });
  if (existing && existing.ownerUserId !== input.ownerUserId)
    return 'owner_mismatch';
  if (existing?.revokedAt) return 'revoked';

  const now = new Date();
  if (existing) {
    await db
      .update(desktopDevices)
      .set({
        name: input.name,
        platform: input.platform,
        capabilities: input.capabilities,
        protocolVersion: input.protocolVersion,
        lastInstanceId: input.instanceId,
        lastConnectedAt: now,
        lastDisconnectedAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(desktopDevices.id, input.id),
          eq(desktopDevices.ownerUserId, input.ownerUserId),
          isNull(desktopDevices.revokedAt),
        ),
      );
    return 'connected';
  }

  await db.insert(desktopDevices).values({
    id: input.id,
    ownerUserId: input.ownerUserId,
    name: input.name,
    platform: input.platform,
    capabilities: input.capabilities,
    protocolVersion: input.protocolVersion,
    lastInstanceId: input.instanceId,
    lastConnectedAt: now,
  });
  return 'connected';
}

export async function listDesktopDevices(ownerUserId: string) {
  return db.query.desktopDevices.findMany({
    where: eq(desktopDevices.ownerUserId, ownerUserId),
    columns: {
      id: true,
      name: true,
      platform: true,
      capabilities: true,
      protocolVersion: true,
      lastInstanceId: true,
      lastConnectedAt: true,
      lastDisconnectedAt: true,
      revokedAt: true,
      createdAt: true,
    },
    orderBy: [
      desc(desktopDevices.lastConnectedAt),
      desc(desktopDevices.createdAt),
    ],
  });
}

export async function getActiveDesktopDevice(
  ownerUserId: string,
  deviceId: string,
) {
  const [device, owner, deployment] = await Promise.all([
    db.query.desktopDevices.findFirst({
      where: and(
        eq(desktopDevices.id, deviceId),
        eq(desktopDevices.ownerUserId, ownerUserId),
        isNull(desktopDevices.revokedAt),
      ),
    }),
    db.query.users.findFirst({
      where: and(eq(users.id, ownerUserId), isNull(users.deletedAt)),
      columns: { id: true },
    }),
    db.query.deploymentSettings.findFirst({
      where: eq(deploymentSettings.id, 'default'),
      columns: { metadata: true },
    }),
  ]);
  return owner && !isRoomoteDeploymentDisabled(deployment?.metadata)
    ? device
    : undefined;
}

export async function markDesktopDeviceDisconnected(
  ownerUserId: string,
  deviceId: string,
): Promise<void> {
  await db
    .update(desktopDevices)
    .set({ lastDisconnectedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(desktopDevices.id, deviceId),
        eq(desktopDevices.ownerUserId, ownerUserId),
      ),
    );
}

export async function revokeDesktopDevice(input: {
  ownerUserId: string;
  deviceId: string;
  actorUserId: string;
  reason?: string;
}): Promise<boolean> {
  const now = new Date();
  const [row] = await db
    .update(desktopDevices)
    .set({
      revokedAt: now,
      revokedByUserId: input.actorUserId,
      revokeReason: input.reason?.slice(0, 200) ?? null,
      updatedAt: now,
    })
    .where(
      and(
        eq(desktopDevices.id, input.deviceId),
        eq(desktopDevices.ownerUserId, input.ownerUserId),
        isNull(desktopDevices.revokedAt),
      ),
    )
    .returning({ id: desktopDevices.id });
  return Boolean(row);
}

export async function recordDesktopDeviceAudit(input: {
  deviceId?: string;
  ownerUserId?: string;
  event: DesktopDeviceAuditEvent;
  actorUserId?: string;
  requestId?: string;
  action?: DesktopDeviceAction;
  outcome?: DesktopDeviceAuditOutcome;
  durationMs?: number;
  responseBytes?: number;
  errorCode?: string;
}): Promise<void> {
  await db.insert(desktopDeviceAudit).values({
    deviceId: input.deviceId,
    ownerUserId: input.ownerUserId,
    event: input.event,
    actorUserId: input.actorUserId,
    requestId: input.requestId,
    action: input.action,
    outcome: input.outcome,
    durationMs: input.durationMs,
    responseBytes: input.responseBytes,
    errorCode: input.errorCode?.slice(0, 100),
  });
}
