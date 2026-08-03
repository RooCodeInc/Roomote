import { Env } from '@roomote/env';
import {
  and,
  db,
  deploymentSettings,
  eq,
  getDeploymentLicenseState,
  getInstanceAnalyticsId,
  resolveConfiguredLicenseKey,
  resolveLicenseState,
  isNull,
} from '@roomote/db/server';

import type {
  LicenseEntitlementValue,
  LicenseUsageReportRequest,
  LicenseUsageReportResponse,
} from '../index';

const REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_LICENSE_CLOUD_BASE_URL = 'https://cloud.roomote.dev';

export type LicenseCloudSyncResult =
  | { status: 'synced' }
  | { status: 'not_licensed' }
  | { status: 'license_in_use' }
  | { status: 'rejected' }
  | { status: 'failed' };

function getLicenseCloudBaseUrl(): string {
  return (
    Env.R_LICENSE_CLOUD_BASE_URL ?? DEFAULT_LICENSE_CLOUD_BASE_URL
  ).replace(/\/+$/, '');
}

function isScalarEntitlementValue(
  value: unknown,
): value is LicenseEntitlementValue {
  return (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

function parseResponse(value: unknown): LicenseUsageReportResponse | null {
  if (value == null || typeof value !== 'object') {
    return null;
  }

  const response = value as Record<string, unknown>;
  if (
    typeof response.licenseId !== 'string' ||
    !response.licenseId ||
    typeof response.activationExpiresAt !== 'string' ||
    Number.isNaN(new Date(response.activationExpiresAt).getTime()) ||
    typeof response.entitlementsVersion !== 'string' ||
    typeof response.entitlementsExpiresAt !== 'string' ||
    Number.isNaN(new Date(response.entitlementsExpiresAt).getTime()) ||
    response.entitlements == null ||
    typeof response.entitlements !== 'object' ||
    Array.isArray(response.entitlements)
  ) {
    return null;
  }

  const entitlementEntries = Object.entries(response.entitlements);
  // A partially usable entitlement response is unsafe: it could silently
  // downgrade a capability while appearing to have renewed successfully.
  // Cloud must return a complete scalar map or the whole lease is rejected.
  if (
    entitlementEntries.some(
      ([, entitlement]) => !isScalarEntitlementValue(entitlement),
    )
  ) {
    return null;
  }

  const entitlements = Object.fromEntries(entitlementEntries);

  return {
    licenseId: response.licenseId,
    activationExpiresAt: response.activationExpiresAt,
    entitlementsVersion: response.entitlementsVersion,
    entitlements,
    entitlementsExpiresAt: response.entitlementsExpiresAt,
  };
}

/**
 * Activates a valid self-hosted license for this deployment and reports an
 * immutable user-count observation. Cloud leases paid-seat capacity back to
 * the deployment, so a copied key cannot activate a second installation.
 */
export async function syncLicenseWithCloud(input: {
  eventId: string;
  observedAt: Date;
  activeUsers: number;
  licenseKey?: string;
}): Promise<LicenseCloudSyncResult> {
  const licenseState = input.licenseKey
    ? resolveLicenseState(input.licenseKey)
    : await getDeploymentLicenseState();
  if (licenseState.status !== 'valid') {
    return { status: 'not_licensed' };
  }

  const [settings, deploymentId] = await Promise.all([
    db.query.deploymentSettings.findFirst({
      where: eq(deploymentSettings.id, 'default'),
      columns: { licenseKey: true },
    }),
    getInstanceAnalyticsId(),
  ]);
  const licenseKey =
    input.licenseKey ?? resolveConfiguredLicenseKey(settings?.licenseKey);
  if (!licenseKey) {
    return { status: 'not_licensed' };
  }

  const request: LicenseUsageReportRequest = {
    contractVersion: 1,
    deploymentId,
    eventId: input.eventId,
    observedAt: input.observedAt.toISOString(),
    ...(Env.RELEASE_VERSION?.trim() && {
      appVersion: Env.RELEASE_VERSION.trim(),
    }),
    usage: { activeUsers: input.activeUsers },
  };

  try {
    const response = await fetch(
      `${getLicenseCloudBaseUrl()}/api/v1/licenses/report`,
      {
        method: 'POST',
        headers: {
          Authorization: `License ${licenseKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );

    if (response.status === 409) {
      return { status: 'license_in_use' };
    }
    if (!response.ok) {
      return { status: 'rejected' };
    }

    const payload = parseResponse(await response.json());
    if (!payload || payload.licenseId !== licenseState.licenseId) {
      return { status: 'rejected' };
    }

    const update = db.update(deploymentSettings).set({
      // An interactive activation must persist its key and lease together.
      // This prevents an older scheduled sync from replacing the lease after
      // the key has changed.
      ...(input.licenseKey != null && { licenseKey }),
      licenseCloudState: {
        ...payload,
        deploymentId,
        lastSyncedAt: new Date().toISOString(),
      },
      updatedAt: new Date(),
    });

    // Compare with the value read before the Cloud request. This makes both
    // scheduled reports and interactive activations safe if another admin
    // changes the configured key while this request is in flight.
    await update.where(
      and(
        eq(deploymentSettings.id, 'default'),
        settings?.licenseKey == null
          ? isNull(deploymentSettings.licenseKey)
          : eq(deploymentSettings.licenseKey, settings.licenseKey),
      ),
    );

    return { status: 'synced' };
  } catch (error) {
    console.warn(
      '[license-cloud] report failed:',
      error instanceof Error ? error.message : error,
    );
    return { status: 'failed' };
  }
}
