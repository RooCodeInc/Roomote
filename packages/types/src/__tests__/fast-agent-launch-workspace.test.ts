import { describe, expect, it } from 'vitest';

import {
  ALL_REPOSITORIES,
  FAST_EXECUTION,
  isFastAgentLaunchTargetSentinel,
  NO_REPOSITORIES,
  resolveFastAgentLaunchWorkspace,
} from '../constants';

describe('resolveFastAgentLaunchWorkspace', () => {
  it('turns the blank-slate sentinel into the repo and never an environment id', () => {
    expect(resolveFastAgentLaunchWorkspace(NO_REPOSITORIES)).toEqual({
      repo: NO_REPOSITORIES,
    });
    expect(
      resolveFastAgentLaunchWorkspace(NO_REPOSITORIES, 'acme/api'),
    ).toEqual({ repo: NO_REPOSITORIES });
  });

  it('keeps the fallback repo for the all-repositories sentinel and for no target', () => {
    expect(resolveFastAgentLaunchWorkspace(ALL_REPOSITORIES)).toEqual({
      repo: ALL_REPOSITORIES,
    });
    expect(resolveFastAgentLaunchWorkspace(null, 'acme/api')).toEqual({
      repo: 'acme/api',
    });
    expect(resolveFastAgentLaunchWorkspace(undefined)).toEqual({
      repo: ALL_REPOSITORIES,
    });
  });

  it('carries a real environment id through with the fallback repo', () => {
    expect(resolveFastAgentLaunchWorkspace('env-1')).toEqual({
      repo: ALL_REPOSITORIES,
      environmentId: 'env-1',
    });
    expect(resolveFastAgentLaunchWorkspace('env-1', 'acme/api')).toEqual({
      repo: 'acme/api',
      environmentId: 'env-1',
    });
  });

  it('never lets the Fast-execution sentinel masquerade as an environment', () => {
    expect(resolveFastAgentLaunchWorkspace(FAST_EXECUTION)).toEqual({
      repo: ALL_REPOSITORIES,
    });
  });
});

describe('isFastAgentLaunchTargetSentinel', () => {
  it('recognises every routing sentinel and nothing else', () => {
    expect(isFastAgentLaunchTargetSentinel(ALL_REPOSITORIES)).toBe(true);
    expect(isFastAgentLaunchTargetSentinel(NO_REPOSITORIES)).toBe(true);
    expect(isFastAgentLaunchTargetSentinel(FAST_EXECUTION)).toBe(true);
    expect(isFastAgentLaunchTargetSentinel('env-1')).toBe(false);
    expect(isFastAgentLaunchTargetSentinel(null)).toBe(false);
    expect(isFastAgentLaunchTargetSentinel(undefined)).toBe(false);
  });
});
