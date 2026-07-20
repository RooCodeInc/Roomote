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
  buildCiFailureTriageDebounceKey,
  buildCiFailureTriageFingerprint,
  buildCiFailureTriageRepoClaimKey,
  releaseCiFailureTriageInvestigation,
  tryClaimCiFailureTriageInvestigation,
} from '../ci-failure-triage-claims';

describe('ci-failure-triage-claims', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('builds stable fingerprint and host-scoped claim keys', () => {
    const fingerprint = buildCiFailureTriageFingerprint({
      repositoryFullName: 'Acme/API',
      workflowName: ' CI ',
      headBranch: 'Main',
      provider: 'github',
      repositoryHost: 'github.com',
    });
    const hostedFingerprint = buildCiFailureTriageFingerprint({
      repositoryFullName: 'Acme/API',
      workflowName: ' CI ',
      headBranch: 'Main',
      provider: 'gitlab',
      repositoryHost: 'GitLab.Example.com',
    });

    // GitHub ignores host so existing webhook/Manual claims stay compatible.
    expect(fingerprint).toBe('acme/api::ci::main');
    expect(hostedFingerprint).toBe('gitlab.example.com::acme/api::ci::main');
    expect(
      buildCiFailureTriageClaimKey({ provider: 'github', fingerprint }),
    ).toBe('ci-failure-triage:github:active:acme/api::ci::main');
    expect(
      buildCiFailureTriageRepoClaimKey({
        provider: 'gitlab',
        repositoryFullName: 'Acme/API',
        repositoryHost: 'GitLab.Example.com',
      }),
    ).toBe('ci-failure-triage:gitlab:active-repo:gitlab.example.com:acme/api');
    expect(
      buildCiFailureTriageRepoClaimKey({
        provider: 'github',
        repositoryFullName: 'Acme/API',
        repositoryHost: 'github.com',
      }),
    ).toBe('ci-failure-triage:github:active-repo:acme/api');
    expect(
      buildCiFailureTriageDebounceKey({
        provider: 'github',
        repositoryId: 'repo-row-1',
      }),
    ).toBe('ci-failure-triage:github:debounce:repo-row-1');
  });

  it('claims both repo and fingerprint keys with host when present', async () => {
    mockSet.mockResolvedValue('OK');

    await expect(
      tryClaimCiFailureTriageInvestigation({
        provider: 'gitlab',
        repositoryFullName: 'acme/api',
        repositoryHost: 'gitlab.example.com',
        fingerprint: 'gitlab.example.com::acme/api::ci::main',
        marker: 'https://example.com/run/1',
      }),
    ).resolves.toBe(true);

    expect(mockSet).toHaveBeenCalledTimes(2);
    expect(mockSet.mock.calls[0]?.[0]).toBe(
      'ci-failure-triage:gitlab:active-repo:gitlab.example.com:acme/api',
    );
    expect(mockSet.mock.calls[1]?.[0]).toBe(
      'ci-failure-triage:gitlab:active:gitlab.example.com::acme/api::ci::main',
    );
  });

  it('rolls back the repo claim when the fingerprint claim fails', async () => {
    mockSet.mockResolvedValueOnce('OK').mockResolvedValueOnce(null);
    mockDel.mockResolvedValue(1);

    await expect(
      tryClaimCiFailureTriageInvestigation({
        provider: 'github',
        repositoryFullName: 'acme/api',
        fingerprint: 'acme/api::ci::main',
        marker: 'run-1',
      }),
    ).resolves.toBe(false);

    expect(mockDel).toHaveBeenCalledWith(
      'ci-failure-triage:github:active-repo:acme/api',
    );
  });

  it('releases both claim keys', async () => {
    mockDel.mockResolvedValue(1);

    await releaseCiFailureTriageInvestigation({
      provider: 'github',
      repositoryFullName: 'acme/api',
      fingerprint: 'acme/api::ci::main',
    });

    expect(mockDel).toHaveBeenCalledWith(
      'ci-failure-triage:github:active:acme/api::ci::main',
    );
    expect(mockDel).toHaveBeenCalledWith(
      'ci-failure-triage:github:active-repo:acme/api',
    );
  });
});
