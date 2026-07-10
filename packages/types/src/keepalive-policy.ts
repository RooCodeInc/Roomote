import { TaskPayloadKind, type CloudTaskLaunchClass } from './cloud-jobs';
import {
  DEFAULT_AUTOMATION_KEEPALIVE_MS,
  DEFAULT_MAINTENANCE_KEEPALIVE_MS,
} from './constants';

const TASK_TYPE_KEEPALIVE_MS_OVERRIDES = new Map<TaskPayloadKind, number>([
  [TaskPayloadKind.GithubPrReviewFollowUp, 0],
]);

export function inferLaunchClassForTaskType(
  taskType: TaskPayloadKind,
): CloudTaskLaunchClass {
  switch (taskType) {
    case TaskPayloadKind.GithubPrReview:
    case TaskPayloadKind.GithubPrReviewSync:
    case TaskPayloadKind.Scan:
    case TaskPayloadKind.McpRecommendations:
    case TaskPayloadKind.GithubPrConflictResolve:
    case TaskPayloadKind.SnapshotEnvironment:
      return 'maintenance';
    default:
      return 'human';
  }
}

export function resolveCloudTaskRuntimePolicy(options: {
  taskType: TaskPayloadKind;
  launchClass?: CloudTaskLaunchClass | null;
  appEnv?: 'development' | 'preview' | 'production' | 'test' | null;
  defaultKeepaliveMs: number;
  delegatedKeepaliveMs: number;
  sandboxTimeoutMs: number;
}): {
  launchClass: CloudTaskLaunchClass;
  keepaliveMs: number;
} {
  const launchClass =
    options.launchClass ?? inferLaunchClassForTaskType(options.taskType);

  return {
    launchClass,
    keepaliveMs: resolveKeepaliveMsForResolvedLaunchClass({
      ...options,
      launchClass,
    }),
  };
}

function capKeepaliveMs(keepaliveMs: number, sandboxTimeoutMs: number): number {
  return Math.min(Math.max(keepaliveMs, 0), sandboxTimeoutMs);
}

function resolveHumanKeepaliveMs(options: {
  appEnv?: 'development' | 'preview' | 'production' | 'test' | null;
  defaultKeepaliveMs: number;
  delegatedKeepaliveMs: number;
  sandboxTimeoutMs: number;
}): number {
  const { appEnv, defaultKeepaliveMs, delegatedKeepaliveMs, sandboxTimeoutMs } =
    options;

  if (appEnv === 'development') {
    return capKeepaliveMs(defaultKeepaliveMs, sandboxTimeoutMs);
  }

  return capKeepaliveMs(delegatedKeepaliveMs, sandboxTimeoutMs);
}

function resolveKeepaliveMsForResolvedLaunchClass(options: {
  taskType?: TaskPayloadKind | null;
  launchClass?: CloudTaskLaunchClass | null;
  appEnv?: 'development' | 'preview' | 'production' | 'test' | null;
  defaultKeepaliveMs: number;
  delegatedKeepaliveMs: number;
  sandboxTimeoutMs: number;
}): number {
  const {
    taskType,
    launchClass,
    appEnv,
    defaultKeepaliveMs,
    delegatedKeepaliveMs,
    sandboxTimeoutMs,
  } = options;

  if (taskType) {
    const keepaliveOverrideMs = TASK_TYPE_KEEPALIVE_MS_OVERRIDES.get(taskType);

    if (keepaliveOverrideMs !== undefined) {
      return capKeepaliveMs(keepaliveOverrideMs, sandboxTimeoutMs);
    }
  }

  switch (launchClass) {
    case 'human':
      return resolveHumanKeepaliveMs({
        appEnv,
        defaultKeepaliveMs,
        delegatedKeepaliveMs,
        sandboxTimeoutMs,
      });
    case 'automation':
      return capKeepaliveMs(DEFAULT_AUTOMATION_KEEPALIVE_MS, sandboxTimeoutMs);
    case 'maintenance':
      return capKeepaliveMs(DEFAULT_MAINTENANCE_KEEPALIVE_MS, sandboxTimeoutMs);
  }

  return resolveHumanKeepaliveMs({
    appEnv,
    defaultKeepaliveMs,
    delegatedKeepaliveMs,
    sandboxTimeoutMs,
  });
}

export function resolveKeepaliveMs(options: {
  taskType?: TaskPayloadKind | null;
  launchClass?: CloudTaskLaunchClass | null;
  appEnv?: 'development' | 'preview' | 'production' | 'test' | null;
  defaultKeepaliveMs: number;
  delegatedKeepaliveMs: number;
  sandboxTimeoutMs: number;
}): number {
  return resolveKeepaliveMsForResolvedLaunchClass({
    ...options,
    launchClass:
      options.launchClass ??
      (options.taskType ? inferLaunchClassForTaskType(options.taskType) : null),
  });
}
