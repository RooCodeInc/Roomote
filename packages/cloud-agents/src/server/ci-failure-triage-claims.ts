import { getRedis } from '@roomote/redis';

/** Keep an active investigation claim longer than a typical fix run. */
export const CI_FAILURE_TRIAGE_CLAIM_TTL_SECONDS = 6 * 60 * 60;

export function buildCiFailureTriageFingerprint(params: {
  repositoryFullName: string;
  workflowName: string;
  headBranch: string;
}): string {
  return [
    params.repositoryFullName.trim().toLowerCase(),
    params.workflowName.trim().toLowerCase(),
    params.headBranch.trim().toLowerCase(),
  ].join('::');
}

export function buildCiFailureTriageClaimKey(fingerprint: string): string {
  return `github:ci-failure-triage:active:${fingerprint}`;
}

export function buildCiFailureTriageRepoClaimKey(
  repositoryFullName: string,
): string {
  return `github:ci-failure-triage:active-repo:${repositoryFullName.trim().toLowerCase()}`;
}

/**
 * Try to claim an active investigation for a failure fingerprint.
 * Returns true when this process holds the claim (SET NX succeeded).
 */
export async function tryClaimCiFailureTriageFingerprint(
  fingerprint: string,
  marker: string,
): Promise<boolean> {
  const redis = getRedis();
  const result = await redis.set(
    buildCiFailureTriageClaimKey(fingerprint),
    marker,
    'EX',
    CI_FAILURE_TRIAGE_CLAIM_TTL_SECONDS,
    'NX',
  );
  return result === 'OK';
}

/**
 * Repo-level claim so manual Run now and any webhook investigation of the same
 * repository cannot both be active at once.
 */
export async function tryClaimCiFailureTriageRepo(
  repositoryFullName: string,
  marker: string,
): Promise<boolean> {
  const redis = getRedis();
  const result = await redis.set(
    buildCiFailureTriageRepoClaimKey(repositoryFullName),
    marker,
    'EX',
    CI_FAILURE_TRIAGE_CLAIM_TTL_SECONDS,
    'NX',
  );
  return result === 'OK';
}

export async function releaseCiFailureTriageFingerprint(
  fingerprint: string,
): Promise<void> {
  const redis = getRedis();
  await redis.del(buildCiFailureTriageClaimKey(fingerprint));
}

export async function releaseCiFailureTriageRepo(
  repositoryFullName: string,
): Promise<void> {
  const redis = getRedis();
  await redis.del(buildCiFailureTriageRepoClaimKey(repositoryFullName));
}

/**
 * Claim both fingerprint (signature-level) and repository (cross-source) keys.
 * Rolls back partial acquisition if the second claim fails.
 */
export async function tryClaimCiFailureTriageInvestigation(params: {
  repositoryFullName: string;
  fingerprint: string;
  marker: string;
}): Promise<boolean> {
  const repoClaimed = await tryClaimCiFailureTriageRepo(
    params.repositoryFullName,
    params.marker,
  );
  if (!repoClaimed) {
    return false;
  }

  const fingerprintClaimed = await tryClaimCiFailureTriageFingerprint(
    params.fingerprint,
    params.marker,
  );
  if (!fingerprintClaimed) {
    await releaseCiFailureTriageRepo(params.repositoryFullName);
    return false;
  }

  return true;
}

export async function releaseCiFailureTriageInvestigation(params: {
  repositoryFullName: string;
  fingerprint: string;
}): Promise<void> {
  await Promise.all([
    releaseCiFailureTriageFingerprint(params.fingerprint),
    releaseCiFailureTriageRepo(params.repositoryFullName),
  ]);
}
