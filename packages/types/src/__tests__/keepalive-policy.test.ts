import { describe, expect, it } from 'vitest';

import { TaskPayloadKind } from '../task-runs';
import {
  DEFAULT_AUTOMATION_KEEPALIVE_MS,
  DEFAULT_MAINTENANCE_KEEPALIVE_MS,
} from '../constants';
import {
  inferLaunchClassForTaskType,
  resolveTaskRuntimePolicy,
  resolveKeepaliveMs,
} from '../keepalive-policy';

describe('inferLaunchClassForTaskType', () => {
  it.each([
    [TaskPayloadKind.GithubPrReview, 'maintenance'],
    [TaskPayloadKind.GithubPrReviewSync, 'maintenance'],
    [TaskPayloadKind.Scan, 'maintenance'],
    [TaskPayloadKind.McpRecommendations, 'maintenance'],
    [TaskPayloadKind.GithubPrConflictResolve, 'maintenance'],
    [TaskPayloadKind.GithubPrReviewFollowUp, 'human'],
    [TaskPayloadKind.SnapshotEnvironment, 'maintenance'],
  ])('maps %s to the %s launch class', (taskType, launchClass) => {
    expect(inferLaunchClassForTaskType(taskType)).toBe(launchClass);
  });
});

describe('resolveTaskRuntimePolicy', () => {
  const defaultKeepaliveMs = 30 * 60 * 1000;
  const delegatedKeepaliveMs = 30 * 60 * 1000;
  const sandboxTimeoutMs = 5 * 60 * 60 * 1000;

  it('resolves launch class and keepalive together for review jobs', () => {
    expect(
      resolveTaskRuntimePolicy({
        taskType: TaskPayloadKind.GithubPrReview,
        appEnv: 'production',
        defaultKeepaliveMs,
        delegatedKeepaliveMs,
        sandboxTimeoutMs,
      }),
    ).toEqual({
      launchClass: 'maintenance',
      keepaliveMs: DEFAULT_MAINTENANCE_KEEPALIVE_MS,
    });
  });

  it('keeps explicit launch-class overrides when resolving policy', () => {
    expect(
      resolveTaskRuntimePolicy({
        taskType: TaskPayloadKind.GithubPrReviewFollowUp,
        launchClass: 'automation',
        appEnv: 'production',
        defaultKeepaliveMs,
        delegatedKeepaliveMs,
        sandboxTimeoutMs,
      }),
    ).toEqual({
      launchClass: 'automation',
      keepaliveMs: 0,
    });
  });

  it('uses the production human default when taskType is present without launch metadata', () => {
    expect(
      resolveKeepaliveMs({
        taskType: TaskPayloadKind.StandardTask,
        appEnv: 'production',
        defaultKeepaliveMs,
        delegatedKeepaliveMs,
        sandboxTimeoutMs,
      }),
    ).toBe(defaultKeepaliveMs);
  });
});

describe('resolveKeepaliveMs', () => {
  const defaultKeepaliveMs = 30 * 60 * 1000;
  const delegatedKeepaliveMs = 30 * 60 * 1000;
  const sandboxTimeoutMs = 5 * 60 * 60 * 1000;

  it('pins automation and maintenance defaults to five minutes', () => {
    expect(DEFAULT_AUTOMATION_KEEPALIVE_MS).toBe(60 * 1000);
    expect(DEFAULT_MAINTENANCE_KEEPALIVE_MS).toBe(5 * 60 * 1000);
  });

  it('uses the human default in production-like environments', () => {
    expect(
      resolveKeepaliveMs({
        launchClass: 'human',
        appEnv: 'production',
        defaultKeepaliveMs,
        delegatedKeepaliveMs,
        sandboxTimeoutMs,
      }),
    ).toBe(delegatedKeepaliveMs);
  });

  it('keeps the shorter human default in development', () => {
    expect(
      resolveKeepaliveMs({
        launchClass: 'human',
        appEnv: 'development',
        defaultKeepaliveMs,
        delegatedKeepaliveMs,
        sandboxTimeoutMs,
      }),
    ).toBe(defaultKeepaliveMs);
  });

  it('uses a one-minute keepalive for automation tasks', () => {
    expect(
      resolveKeepaliveMs({
        launchClass: 'automation',
        appEnv: 'production',
        defaultKeepaliveMs,
        delegatedKeepaliveMs,
        sandboxTimeoutMs,
      }),
    ).toBe(DEFAULT_AUTOMATION_KEEPALIVE_MS);
  });

  it('uses the maintenance keepalive for maintenance tasks', () => {
    expect(
      resolveKeepaliveMs({
        launchClass: 'maintenance',
        appEnv: 'production',
        defaultKeepaliveMs,
        delegatedKeepaliveMs,
        sandboxTimeoutMs,
      }),
    ).toBe(DEFAULT_MAINTENANCE_KEEPALIVE_MS);
  });

  it.each([TaskPayloadKind.GithubPrReview, TaskPayloadKind.GithubPrReviewSync])(
    'uses the maintenance keepalive for %s jobs',
    (taskType) => {
      expect(
        resolveKeepaliveMs({
          taskType,
          launchClass: 'maintenance',
          appEnv: 'production',
          defaultKeepaliveMs,
          delegatedKeepaliveMs,
          sandboxTimeoutMs,
        }),
      ).toBe(DEFAULT_MAINTENANCE_KEEPALIVE_MS);
    },
  );

  it('keeps an immediate keepalive for PR review follow-up jobs', () => {
    expect(
      resolveKeepaliveMs({
        taskType: TaskPayloadKind.GithubPrReviewFollowUp,
        launchClass: 'human',
        appEnv: 'production',
        defaultKeepaliveMs,
        delegatedKeepaliveMs,
        sandboxTimeoutMs,
      }),
    ).toBe(0);
  });

  it('falls back to the human keepalive behavior when launch class is unavailable', () => {
    expect(
      resolveKeepaliveMs({
        appEnv: 'production',
        defaultKeepaliveMs,
        delegatedKeepaliveMs,
        sandboxTimeoutMs,
      }),
    ).toBe(defaultKeepaliveMs);
  });

  it('caps the resolved keepalive to the sandbox timeout', () => {
    expect(
      resolveKeepaliveMs({
        launchClass: 'human',
        appEnv: 'production',
        defaultKeepaliveMs,
        delegatedKeepaliveMs,
        sandboxTimeoutMs: 3 * 60 * 1000,
      }),
    ).toBe(3 * 60 * 1000);
  });
});
