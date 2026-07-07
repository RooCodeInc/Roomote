// pnpm --filter @roomote/worker test src/run-task/__tests__/completion.test.ts

import {
  CloudTaskType,
  DEFAULT_MAINTENANCE_KEEPALIVE_MS,
} from '@roomote/types';

import { getDefaultKeepaliveMs } from '../completion';

describe('getDefaultKeepaliveMs', () => {
  const DEFAULT_KEEPALIVE_MS = 30 * 60 * 1000;
  const DEFAULT_DELEGATED_KEEPALIVE_MS = 30 * 60 * 1000;
  const SANDBOX_TIMEOUT_MS = 5 * 60 * 60 * 1000;

  it('uses the delegated human keepalive in production', () => {
    expect(
      getDefaultKeepaliveMs({
        appEnv: 'production',
        defaultKeepaliveMs: DEFAULT_KEEPALIVE_MS,
        delegatedKeepaliveMs: DEFAULT_DELEGATED_KEEPALIVE_MS,
        sandboxTimeoutMs: SANDBOX_TIMEOUT_MS,
      }),
    ).toBe(DEFAULT_DELEGATED_KEEPALIVE_MS);
  });

  it('keeps the human keepalive aligned in development', () => {
    expect(
      getDefaultKeepaliveMs({
        appEnv: 'development',
        defaultKeepaliveMs: DEFAULT_KEEPALIVE_MS,
        delegatedKeepaliveMs: DEFAULT_DELEGATED_KEEPALIVE_MS,
        sandboxTimeoutMs: SANDBOX_TIMEOUT_MS,
      }),
    ).toBe(DEFAULT_KEEPALIVE_MS);
  });

  it('caps the delegated keepalive at the sandbox timeout', () => {
    expect(
      getDefaultKeepaliveMs({
        appEnv: 'production',
        defaultKeepaliveMs: DEFAULT_KEEPALIVE_MS,
        delegatedKeepaliveMs: DEFAULT_DELEGATED_KEEPALIVE_MS,
        sandboxTimeoutMs: 15 * 60 * 1000,
      }),
    ).toBe(15 * 60 * 1000);
  });

  it.each([CloudTaskType.GithubPrReview, CloudTaskType.GithubPrReviewSync])(
    'uses the maintenance keepalive for %s jobs',
    (taskType) => {
      expect(
        getDefaultKeepaliveMs({
          taskType,
          appEnv: 'production',
          defaultKeepaliveMs: DEFAULT_KEEPALIVE_MS,
          delegatedKeepaliveMs: DEFAULT_DELEGATED_KEEPALIVE_MS,
          sandboxTimeoutMs: SANDBOX_TIMEOUT_MS,
        }),
      ).toBe(DEFAULT_MAINTENANCE_KEEPALIVE_MS);
    },
  );

  it('keeps an immediate keepalive for PR review follow-up jobs', () => {
    expect(
      getDefaultKeepaliveMs({
        taskType: CloudTaskType.GithubPrReviewFollowUp,
        appEnv: 'production',
        defaultKeepaliveMs: DEFAULT_KEEPALIVE_MS,
        delegatedKeepaliveMs: DEFAULT_DELEGATED_KEEPALIVE_MS,
        sandboxTimeoutMs: SANDBOX_TIMEOUT_MS,
      }),
    ).toBe(0);
  });

  it('uses the production human fallback when launch metadata is missing', () => {
    expect(
      getDefaultKeepaliveMs({
        taskType: CloudTaskType.StandardTask,
        appEnv: 'production',
        defaultKeepaliveMs: DEFAULT_KEEPALIVE_MS,
        delegatedKeepaliveMs: DEFAULT_DELEGATED_KEEPALIVE_MS,
        sandboxTimeoutMs: SANDBOX_TIMEOUT_MS,
      }),
    ).toBe(DEFAULT_KEEPALIVE_MS);
  });
});
