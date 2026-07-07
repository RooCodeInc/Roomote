import { createPublicKey, verify as verifySignature } from 'node:crypto';

import {
  db,
  type DatabaseOrTransaction,
  deploymentSettings,
  eq,
  isNull,
  sql,
  users,
} from '@roomote/db/server';

const DEFAULT_DEPLOYMENT_ID = 'default';

/**
 * Deployments run free up to this many active (non-deleted) user accounts; a
 * valid license key raises the limit to the key's seat count. This gate is
 * license key functionality under FCL-1.0-ALv2 (see LICENSE, "Limitations"):
 * moving, changing, disabling, or circumventing it is not a permitted use of
 * the Software.
 */
export const FREE_SEAT_LIMIT = 10;

/** Version prefix for Roomote license keys: RMLK1.<payload>.<signature>. */
const LICENSE_KEY_PREFIX = 'RMLK1';

/** Ed25519 public half of the Roomote license signing key (SPKI DER, base64). */
const LICENSE_PUBLIC_KEY_SPKI_B64 =
  'MCowBQYDK2VwAyEALp8Px1N98T1Gh4a8zbj6EnpyWbxF3VJNqTKmXvxK8xc=';

type LicensePayload = {
  /** Stable identifier for the issued license, e.g. "lic_ab12cd34". */
  licenseId: string;
  /** Display name of the license holder. */
  licensee: string;
  /** Total active user accounts the deployment may have. */
  maxSeats: number;
  issuedAt: Date;
  /** Null for perpetual licenses. */
  expiresAt: Date | null;
};

type DeploymentLicenseState =
  | { status: 'unlicensed'; seatLimit: number }
  | { status: 'invalid'; seatLimit: number }
  | ({ status: 'valid' | 'expired'; seatLimit: number } & LicensePayload);

function parseIsoDate(value: unknown): Date | null {
  if (typeof value !== 'string') {
    return null;
  }

  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Verify a license key's signature and shape. Returns the signed payload, or
 * null when the key is malformed or not signed by the Roomote licensing key.
 * Expiry is not checked here; callers decide what an expired license means.
 */
export function verifyLicenseKey(
  licenseKey: string,
  publicKeySpkiB64: string = LICENSE_PUBLIC_KEY_SPKI_B64,
): LicensePayload | null {
  const [prefix, payloadB64, signatureB64, ...rest] = licenseKey
    .trim()
    .split('.');

  if (
    prefix !== LICENSE_KEY_PREFIX ||
    !payloadB64 ||
    !signatureB64 ||
    rest.length > 0
  ) {
    return null;
  }

  let payload: Record<string, unknown>;

  try {
    const payloadBytes = Buffer.from(payloadB64, 'base64url');
    const signature = Buffer.from(signatureB64, 'base64url');
    const publicKey = createPublicKey({
      key: Buffer.from(publicKeySpkiB64, 'base64'),
      format: 'der',
      type: 'spki',
    });

    if (!verifySignature(null, payloadBytes, publicKey, signature)) {
      return null;
    }

    payload = JSON.parse(payloadBytes.toString('utf8')) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }

  const issuedAt = parseIsoDate(payload.issuedAt);
  const expiresAt =
    payload.expiresAt == null ? null : parseIsoDate(payload.expiresAt);

  if (
    typeof payload.licenseId !== 'string' ||
    !payload.licenseId ||
    typeof payload.licensee !== 'string' ||
    !payload.licensee ||
    typeof payload.maxSeats !== 'number' ||
    !Number.isInteger(payload.maxSeats) ||
    payload.maxSeats < 1 ||
    issuedAt == null ||
    (payload.expiresAt != null && expiresAt == null)
  ) {
    return null;
  }

  return {
    licenseId: payload.licenseId,
    licensee: payload.licensee,
    maxSeats: payload.maxSeats,
    issuedAt,
    expiresAt,
  };
}

/**
 * Resolve a stored license key (or its absence) into the deployment's seat
 * limit. Expired and invalid keys fall back to the free limit rather than
 * locking anyone out; the gate only ever blocks adding users beyond the limit.
 */
export function resolveLicenseState(
  licenseKey: string | null | undefined,
  now: Date = new Date(),
  publicKeySpkiB64: string = LICENSE_PUBLIC_KEY_SPKI_B64,
): DeploymentLicenseState {
  if (!licenseKey || !licenseKey.trim()) {
    return { status: 'unlicensed', seatLimit: FREE_SEAT_LIMIT };
  }

  const payload = verifyLicenseKey(licenseKey, publicKeySpkiB64);

  if (!payload) {
    return { status: 'invalid', seatLimit: FREE_SEAT_LIMIT };
  }

  if (
    payload.expiresAt != null &&
    payload.expiresAt.getTime() <= now.getTime()
  ) {
    return { ...payload, status: 'expired', seatLimit: FREE_SEAT_LIMIT };
  }

  return {
    ...payload,
    status: 'valid',
    seatLimit: Math.max(payload.maxSeats, FREE_SEAT_LIMIT),
  };
}

/**
 * Read the deployment's license key and resolve its state. Pass a transaction
 * to read the settings row under that transaction's locks (the seat gate does
 * this with the row locked FOR UPDATE to serialize concurrent admissions).
 */
export async function getDeploymentLicenseState(
  executor: DatabaseOrTransaction = db,
): Promise<DeploymentLicenseState> {
  const [settings] = await executor
    .select({ licenseKey: deploymentSettings.licenseKey })
    .from(deploymentSettings)
    .where(eq(deploymentSettings.id, DEFAULT_DEPLOYMENT_ID))
    .limit(1);

  return resolveLicenseState(settings?.licenseKey);
}

/** Thrown to roll back user creation when the deployment is at its seat limit. */
export class SeatLimitExceededError extends Error {
  constructor(seatLimit: number) {
    super(
      `This deployment has reached its licensed limit of ${seatLimit} users.`,
    );
    this.name = 'SeatLimitExceededError';
  }
}

/**
 * Read-only seat availability check for UX gates (e.g. rejecting sign-up
 * before an auth user is created, so the form can show the seat-limit error
 * inline). Takes no lock; the authoritative gate is assertSeatAvailable()
 * inside the admission transaction.
 */
export async function hasSeatAvailable(): Promise<boolean> {
  const [licenseState, [activeUsers]] = await Promise.all([
    getDeploymentLicenseState(),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(users)
      .where(isNull(users.deletedAt)),
  ]);

  return (activeUsers?.count ?? 0) < licenseState.seatLimit;
}

/**
 * The seat gate (license key functionality under FCL-1.0-ALv2): throws
 * SeatLimitExceededError unless the deployment has a free seat for one more
 * active user. Must run inside the transaction that admits the user — it
 * locks the deployment_settings row FOR UPDATE so concurrent admissions
 * serialize on the count and cannot pass the gate together.
 */
export async function assertSeatAvailable(
  tx: DatabaseOrTransaction,
): Promise<void> {
  const [settings] = await tx
    .select({ licenseKey: deploymentSettings.licenseKey })
    .from(deploymentSettings)
    .where(eq(deploymentSettings.id, DEFAULT_DEPLOYMENT_ID))
    .for('update');

  const [activeUsers] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(users)
    .where(isNull(users.deletedAt));

  const licenseState = resolveLicenseState(settings?.licenseKey);

  if ((activeUsers?.count ?? 0) >= licenseState.seatLimit) {
    throw new SeatLimitExceededError(licenseState.seatLimit);
  }
}
