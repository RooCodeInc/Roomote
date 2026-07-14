import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSet, mockDel } = vi.hoisted(() => ({
  mockSet: vi.fn(),
  mockDel: vi.fn(),
}));

vi.mock('@roomote/redis', () => ({
  getRedis: () => ({
    set: (...args: unknown[]) => mockSet(...args),
    del: (...args: unknown[]) => mockDel(...args),
  }),
}));

import {
  buildCiFailureTriageClaimKey,
  buildCiFailureTriageFingerprint,
  buildCiFailureTriageRepoClaimKey,
  releaseCiFailureTriageInvestigation,
  tryClaimCiFailureTriageInvestigation,
} from '../ci-failure-triage-claims';

describe('ci-failure-triage-claims', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('builds stable fingerprint and claim keys', () => {
    const fingerprint = buildCiFailureTriageFingerprint({
      repositoryFullName: 'Acme/API',
      workflowName: ' CI ',
      headBranch: 'Main',
    });

    expect(fingerprint).toBe('acme/api::ci::main');
    expect(buildCiFailureTriageClaimKey(fingerprint)).toBe(
      'github:ci-failure-triage:active:acme/api::ci::main',
    );
    expect(buildCiFailureTriageRepoClaimKey('Acme/API')).toBe(
      'github:ci-failure-triage:active-repo:acme/api',
    );
  });

  it('claims both repo and fingerprint keys', async () => {
    mockSet.mockResolvedValue('OK');

    await expect(
      tryClaimCiFailureTriageInvestigation({
        repositoryFullName: 'acme/api',
        fingerprint: 'acme/api::ci::main',
        marker: 'https://example.com/run/1',
      }),
    ).resolves.toBe(true);

    expect(mockSet).toHaveBeenCalledTimes(2);
    expect(mockSet.mock.calls[0]?.[0]).toBe(
      'github:ci-failure-triage:active-repo:acme/api',
    );
    expect(mockSet.mock.calls[1]?.[0]).toBe(
      'github:ci-failure-triage:active:acme/api::ci::main',
    );
  });

  it('rolls back the repo claim when the fingerprint claim fails', async () => {
    mockSet.mockResolvedValueOnce('OK').mockResolvedValueOnce(null);
    mockDel.mockResolvedValue(1);

    await expect(
      tryClaimCiFailureTriageInvestigation({
        repositoryFullName: 'acme/api',
        fingerprint: 'acme/api::ci::main',
        marker: 'run-1',
      }),
    ).resolves.toBe(false);

    expect(mockDel).toHaveBeenCalledWith(
      'github:ci-failure-triage:active-repo:acme/api',
    );
  });

  it('releases both claim keys', async () => {
    mockDel.mockResolvedValue(1);

    await releaseCiFailureTriageInvestigation({
      repositoryFullName: 'acme/api',
      fingerprint: 'acme/api::ci::main',
    });

    expect(mockDel).toHaveBeenCalledWith(
      'github:ci-failure-triage:active:acme/api::ci::main',
    );
    expect(mockDel).toHaveBeenCalledWith(
      'github:ci-failure-triage:active-repo:acme/api',
    );
  });
});
