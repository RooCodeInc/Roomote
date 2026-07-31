export {
  FREE_SEAT_LIMIT,
  SeatLimitExceededError,
  assertSeatAvailable,
  getDeploymentLicenseState,
  getEnvLicenseKey,
  hasSeatAvailable,
  resolveConfiguredLicenseKey,
  resolveLicenseState,
  verifyLicenseKey,
  type DeploymentLicenseState,
  type LicensePayload,
} from '@roomote/db/server';
