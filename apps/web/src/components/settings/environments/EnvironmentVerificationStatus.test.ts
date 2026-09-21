import { describe, expect, it } from 'vitest';

import type { EnvironmentRecipe } from '@roomote/types';

import { getEnvironmentVerificationState } from './EnvironmentVerificationStatus';

const resolvedRecipe: EnvironmentRecipe = {
  type: 'r-bioconductor',
  schema_version: 1,
  request: { packages: ['DESeq2'] },
  request_fingerprint: 'a'.repeat(64),
  resolution: {
    image:
      'bioconductor/bioconductor_docker@sha256:41ed449aa2181f330cdc8d0499a11a7435b04827ff926dc141584a34f65a12cb',
    r_version: '4.5.2',
    bioconductor_version: '3.21',
    packages: [
      { name: 'DESeq2', version: '1.48.2', repository: 'bioconductor' },
    ],
    renv_lock: { R: { Version: '4.5.2' } },
    resolution_fingerprint: 'b'.repeat(64),
  },
};

const unresolvedRecipe: EnvironmentRecipe = {
  type: 'r-bioconductor',
  schema_version: 1,
  request: { packages: ['DESeq2'] },
  request_fingerprint: 'a'.repeat(64),
};

describe('getEnvironmentVerificationState', () => {
  it('derives Configuring for an unresolved recipe', () => {
    expect(
      getEnvironmentVerificationState({
        isVerified: false,
        verificationTaskId: 'task-1',
        verificationTaskActive: true,
        verificationError: null,
        config: {
          name: 'R analysis',
          repositories: [],
          environment_recipe: unresolvedRecipe,
        },
      }),
    ).toBe('configuring');
  });

  it('does not leave an unresolved candidate configuring without an active task', () => {
    expect(
      getEnvironmentVerificationState({
        isVerified: false,
        verificationTaskId: null,
        verificationTaskActive: false,
        verificationError: null,
        config: {
          name: 'R analysis',
          repositories: [],
          environment_recipe: unresolvedRecipe,
        },
      }),
    ).toBe('configured');
  });

  it('derives Verifying for a resolved recipe with an active verification task', () => {
    expect(
      getEnvironmentVerificationState({
        isVerified: false,
        verificationTaskId: 'task-1',
        verificationTaskActive: true,
        verificationError: null,
        config: {
          name: 'R analysis',
          repositories: [],
          environment_recipe: resolvedRecipe,
        },
      }),
    ).toBe('verifying');
  });

  it('derives Ready once verified', () => {
    expect(
      getEnvironmentVerificationState({
        isVerified: true,
        verificationTaskId: 'task-1',
        verificationTaskActive: false,
        verificationError: null,
        config: {
          name: 'R analysis',
          repositories: [],
          environment_recipe: resolvedRecipe,
        },
      }),
    ).toBe('ready');
  });

  it('derives Failed for resolution or verification errors', () => {
    expect(
      getEnvironmentVerificationState({
        isVerified: false,
        verificationTaskId: null,
        verificationTaskActive: false,
        verificationError: 'package not found',
        config: {
          name: 'R analysis',
          repositories: [],
          environment_recipe: unresolvedRecipe,
        },
      }),
    ).toBe('failed');
  });

  it('derives Configured for an ordinary environment', () => {
    expect(
      getEnvironmentVerificationState({
        isVerified: false,
        verificationTaskId: null,
        verificationTaskActive: false,
        verificationError: null,
        config: { name: 'Service', repositories: [] },
      }),
    ).toBe('configured');
  });
});
