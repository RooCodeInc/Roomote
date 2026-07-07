import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import {
  and,
  db,
  type DatabaseOrTransaction,
  desc,
  eq,
  invites,
  isNotNull,
  isNull,
  lt,
  sql,
  users,
} from '@roomote/db/server';
import type { UserRole } from '@roomote/types';

import { Env } from './env';

const DEFAULT_INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

type InviteRow = typeof invites.$inferSelect;

export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function generateInviteToken(): string {
  return randomBytes(24).toString('base64url');
}

export function buildInviteUrl(baseUrl: string, token: string): string {
  return new URL(`/invite/${encodeURIComponent(token)}`, baseUrl).toString();
}

export function isInviteUsable(
  invite: Pick<InviteRow, 'revokedAt' | 'expiresAt' | 'usedCount' | 'maxUses'>,
  now: Date = new Date(),
): boolean {
  if (invite.revokedAt != null) {
    return false;
  }

  if (invite.expiresAt != null && invite.expiresAt.getTime() <= now.getTime()) {
    return false;
  }

  return invite.usedCount < invite.maxUses;
}

export async function createInvite({
  label,
  invitedByUserId,
  role = 'member',
  maxUses = 1,
  ttlMs = DEFAULT_INVITE_TTL_MS,
}: {
  label?: string | null;
  invitedByUserId: string;
  role?: UserRole;
  maxUses?: number;
  ttlMs?: number | null;
}): Promise<{ invite: InviteRow; token: string }> {
  const token = generateInviteToken();

  const [invite] = await db
    .insert(invites)
    .values({
      tokenHash: hashInviteToken(token),
      label: label?.trim() || null,
      invitedByUserId,
      role,
      maxUses: Math.max(1, maxUses),
      expiresAt: ttlMs == null ? null : new Date(Date.now() + ttlMs),
    })
    .returning();

  if (!invite) {
    throw new Error('Failed to create invite.');
  }

  return { invite, token };
}

export async function listInvites(): Promise<
  Array<InviteRow & { acceptedUserCount: number }>
> {
  const [inviteRows, acceptedCounts] = await Promise.all([
    db.select().from(invites).orderBy(desc(invites.createdAt)),
    db
      .select({
        inviteId: users.invitedByInviteId,
        acceptedUserCount: sql<number>`count(*)::int`,
      })
      .from(users)
      .where(isNotNull(users.invitedByInviteId))
      .groupBy(users.invitedByInviteId),
  ]);

  const acceptedCountByInviteId = new Map(
    acceptedCounts.map((row) => [row.inviteId, row.acceptedUserCount]),
  );

  return inviteRows.map((invite) => ({
    ...invite,
    acceptedUserCount: acceptedCountByInviteId.get(invite.id) ?? 0,
  }));
}

export async function revokeInvite(inviteId: string): Promise<boolean> {
  const revoked = await db
    .update(invites)
    .set({ revokedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(invites.id, inviteId), isNull(invites.revokedAt)))
    .returning({ id: invites.id });

  return revoked.length > 0;
}

/** Look up a usable invite by raw token; null when unknown or exhausted. */
export async function findUsableInviteByToken(
  token: string | null | undefined,
): Promise<InviteRow | null> {
  if (!token || !token.trim()) {
    return null;
  }

  const [invite] = await db
    .select()
    .from(invites)
    .where(eq(invites.tokenHash, hashInviteToken(token.trim())))
    .limit(1);

  if (!invite || !isInviteUsable(invite)) {
    return null;
  }

  return invite;
}

/** Thrown to roll back user creation when its invite can no longer be redeemed. */
export class InviteRedemptionFailedError extends Error {
  constructor() {
    super('Invite is no longer valid.');
    this.name = 'InviteRedemptionFailedError';
  }
}

/**
 * Atomically consume one use of an invite. Returns false when the invite was
 * revoked or exhausted by a concurrent redemption, in which case the caller
 * must deny access.
 */
export async function redeemInvite(
  inviteId: string,
  executor: DatabaseOrTransaction = db,
): Promise<boolean> {
  const redeemed = await executor
    .update(invites)
    .set({
      usedCount: sql`${invites.usedCount} + 1`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(invites.id, inviteId),
        isNull(invites.revokedAt),
        lt(invites.usedCount, invites.maxUses),
      ),
    )
    .returning({ id: invites.id });

  return redeemed.length > 0;
}

/**
 * Whether the presented setup token matches SETUP_TOKEN. This is the
 * deployment's standing "system invite" for its first admin.
 */
export function isSystemInviteToken(token: string | null | undefined): boolean {
  const requiredToken = Env.SETUP_TOKEN;

  if (!requiredToken || !token) {
    return false;
  }

  const tokenBuffer = Buffer.from(token);
  const requiredBuffer = Buffer.from(requiredToken);

  return (
    tokenBuffer.length === requiredBuffer.length &&
    timingSafeEqual(tokenBuffer, requiredBuffer)
  );
}
