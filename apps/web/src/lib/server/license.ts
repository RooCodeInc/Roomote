export {
  FREE_SEAT_LIMIT,
  LICENSE_PUBLIC_KEY_SPKI_B64,
  SeatLimitExceededError,
  assertSeatAvailable,
  getEffectiveDeploymentSeatLimit,
  getEffectiveSeatLimit,
  getDeploymentLicenseState,
  getEnvLicenseKey,
  hasSeatAvailable,
  resolveConfiguredLicenseKey,
  resolveLicenseState,
  verifyLicenseKey,
} from '@roomote/db/server';
