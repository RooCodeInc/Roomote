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
