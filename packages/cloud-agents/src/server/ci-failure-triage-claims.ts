import type { SourceControlProvider } from '@roomote/types';
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

export function buildCiFailureTriageClaimKey(params: {
  provider: SourceControlProvider;
  fingerprint: string;
}): string {
  return `ci-failure-triage:${params.provider}:active:${params.fingerprint}`;
}

export function buildCiFailureTriageRepoClaimKey(params: {
  provider: SourceControlProvider;
  repositoryFullName: string;
}): string {
  return `ci-failure-triage:${params.provider}:active-repo:${params.repositoryFullName.trim().toLowerCase()}`;
}

export function buildCiFailureTriageDebounceKey(params: {
  provider: SourceControlProvider;
  repositoryId: string;
}): string {
  return `ci-failure-triage:${params.provider}:debounce:${params.repositoryId}`;
}

/**
 * Try to claim an active investigation for a failure fingerprint.
 * Returns true when this process holds the claim (SET NX succeeded).
 */
export async function tryClaimCiFailureTriageFingerprint(params: {
  provider: SourceControlProvider;
  fingerprint: string;
  marker: string;
}): Promise<boolean> {
  const redis = getRedis();
  const result = await redis.set(
    buildCiFailureTriageClaimKey({
      provider: params.provider,
      fingerprint: params.fingerprint,
    }),
    params.marker,
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
export async function tryClaimCiFailureTriageRepo(params: {
  provider: SourceControlProvider;
  repositoryFullName: string;
  marker: string;
}): Promise<boolean> {
  const redis = getRedis();
  const result = await redis.set(
    buildCiFailureTriageRepoClaimKey({
      provider: params.provider,
      repositoryFullName: params.repositoryFullName,
    }),
    params.marker,
    'EX',
    CI_FAILURE_TRIAGE_CLAIM_TTL_SECONDS,
    'NX',
  );
  return result === 'OK';
}

export async function releaseCiFailureTriageFingerprint(params: {
  provider: SourceControlProvider;
  fingerprint: string;
}): Promise<void> {
  const redis = getRedis();
  await redis.del(
    buildCiFailureTriageClaimKey({
      provider: params.provider,
      fingerprint: params.fingerprint,
    }),
  );
}

export async function releaseCiFailureTriageRepo(params: {
  provider: SourceControlProvider;
  repositoryFullName: string;
}): Promise<void> {
  const redis = getRedis();
  await redis.del(
    buildCiFailureTriageRepoClaimKey({
      provider: params.provider,
      repositoryFullName: params.repositoryFullName,
    }),
  );
}

/**
 * Claim both fingerprint (signature-level) and repository (cross-source) keys.
 * Rolls back partial acquisition if the second claim fails.
 */
export async function tryClaimCiFailureTriageInvestigation(params: {
  provider: SourceControlProvider;
  repositoryFullName: string;
  fingerprint: string;
  marker: string;
}): Promise<boolean> {
  const repoClaimed = await tryClaimCiFailureTriageRepo({
    provider: params.provider,
    repositoryFullName: params.repositoryFullName,
    marker: params.marker,
  });
  if (!repoClaimed) {
    return false;
  }

  const fingerprintClaimed = await tryClaimCiFailureTriageFingerprint({
    provider: params.provider,
    fingerprint: params.fingerprint,
    marker: params.marker,
  });
  if (!fingerprintClaimed) {
    await releaseCiFailureTriageRepo({
      provider: params.provider,
      repositoryFullName: params.repositoryFullName,
    });
    return false;
  }

  return true;
}

export async function releaseCiFailureTriageInvestigation(params: {
  provider: SourceControlProvider;
  repositoryFullName: string;
  fingerprint: string;
}): Promise<void> {
  await Promise.all([
    releaseCiFailureTriageFingerprint({
      provider: params.provider,
      fingerprint: params.fingerprint,
    }),
    releaseCiFailureTriageRepo({
      provider: params.provider,
      repositoryFullName: params.repositoryFullName,
    }),
  ]);
}
