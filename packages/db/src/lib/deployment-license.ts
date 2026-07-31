import { createPublicKey, verify as verifySignature } from 'node:crypto';

import { Env } from '@roomote/env';

import { db, type DatabaseOrTransaction } from '../db';
import { deploymentSettings, users } from '../schema';
import { eq, isNull, sql } from 'drizzle-orm';

const DEFAULT_DEPLOYMENT_ID = 'default';

/** Free active-user limit before a paid license key is required. */
export const FREE_SEAT_LIMIT = 10;

const LICENSE_KEY_PREFIX = 'RMLK1';
const LICENSE_PUBLIC_KEY_SPKI_B64 =
  'MCowBQYDK2VwAyEALp8Px1N98T1Gh4a8zbj6EnpyWbxF3VJNqTKmXvxK8xc=';

export type LicensePayload = {
  licenseId: string;
  licensee: string;
  maxSeats: number;
  issuedAt: Date;
  expiresAt: Date | null;
};

export type DeploymentLicenseState =
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

export function getEnvLicenseKey(): string | null {
  const value = Env.R_LICENSE_KEY?.trim();
  return value || null;
}

export function resolveConfiguredLicenseKey(
  storedLicenseKey: string | null | undefined,
): string | null {
  return getEnvLicenseKey() ?? (storedLicenseKey?.trim() || null);
}

export async function getDeploymentLicenseState(
  executor: DatabaseOrTransaction = db,
): Promise<DeploymentLicenseState> {
  const envLicenseKey = getEnvLicenseKey();
  if (envLicenseKey) {
    return resolveLicenseState(envLicenseKey);
  }

  const [settings] = await executor
    .select({ licenseKey: deploymentSettings.licenseKey })
    .from(deploymentSettings)
    .where(eq(deploymentSettings.id, DEFAULT_DEPLOYMENT_ID))
    .limit(1);

  return resolveLicenseState(settings?.licenseKey);
}

export class SeatLimitExceededError extends Error {
  constructor(seatLimit: number) {
    super(
      `This deployment has reached its licensed limit of ${seatLimit} users.`,
    );
    this.name = 'SeatLimitExceededError';
  }
}

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

  const licenseState = resolveLicenseState(
    resolveConfiguredLicenseKey(settings?.licenseKey),
  );

  if ((activeUsers?.count ?? 0) >= licenseState.seatLimit) {
    throw new SeatLimitExceededError(licenseState.seatLimit);
  }
}
