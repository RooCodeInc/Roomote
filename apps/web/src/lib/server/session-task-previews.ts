import { resolveEffectivePreviewRuntimeConfig } from '@roomote/db/server';
import {
  appendInitialPath,
  getPrimaryPortName,
  isExitedRunStatus,
  SYSTEM_PORT_NAMES,
  type RunStatus,
} from '@roomote/types';

import { buildTaskPreviewUrls } from '@/lib/preview-urls';

import { Env } from './env';

/**
 * A live preview URL exposed by a session-linked task, ready for the session
 * workspace to embed via the preview-iframe auth route.
 */
export type SessionTaskPreview = {
  serviceName: string;
  url: string;
  isPrimary: boolean;
  runId: number;
};

type SessionPreviewProxyConfig = {
  previewProxyBaseUrl: string | null;
  previewProxySubdomainSuffix: string | null;
};

/**
 * Resolve the effective preview-proxy config once per session read so every
 * linked task's preview URLs are built against the same deployment settings.
 */
export async function getSessionPreviewProxyConfig(): Promise<SessionPreviewProxyConfig> {
  const resolvedConfig = await resolveEffectivePreviewRuntimeConfig({
    runtimeEnv: process.env,
    defaultPreviewProxyBaseUrl: Env.PREVIEW_PROXY_BASE_URL,
    defaultPreviewDomains: Env.PREVIEW_DOMAINS,
  });

  return {
    previewProxyBaseUrl: resolvedConfig.effective.previewProxyBaseUrl ?? null,
    previewProxySubdomainSuffix:
      resolvedConfig.effective.previewProxySubdomainSuffix ?? null,
  };
}

type SessionPreviewRunFields = {
  id: number;
  status: RunStatus;
  machineDomain: string | null;
  machineDomains: Record<string, string> | null;
  initialPaths: Record<string, string> | null;
  primaryPortName: string | null;
  sleepRequestedAt: Date | null;
  snapshotRequestedAt: Date | null;
  snapshotCreatedAt: Date | null;
  snapshotFailedAt: Date | null;
  snapshotId: string | null;
};

// Mirrors the task workspace's isTaskRunAsleep: once the sandbox is going to
// sleep or already snapshotted, its preview domains no longer serve anything.
function isRunAsleep(run: SessionPreviewRunFields): boolean {
  const isGoingToSleep =
    (!!run.sleepRequestedAt || !!run.snapshotRequestedAt) &&
    !run.snapshotCreatedAt &&
    !run.snapshotFailedAt;

  return isGoingToSleep || !!run.snapshotId;
}

/**
 * Live preview entries for one session-linked task, primary service first.
 * Exited or sleeping runs return no entries: their sandbox (and therefore the
 * preview origin) is gone, and the task page owns the wake-up flow.
 */
export function buildSessionTaskPreviews(
  taskId: string,
  run: SessionPreviewRunFields | null | undefined,
  config: SessionPreviewProxyConfig,
): SessionTaskPreview[] {
  if (!run?.machineDomains) return [];
  if (isExitedRunStatus(run.status) || isRunAsleep(run)) return [];

  const previewUrls = buildTaskPreviewUrls(
    taskId,
    run.machineDomains,
    config.previewProxyBaseUrl,
    config.previewProxySubdomainSuffix,
  );
  if (!previewUrls) return [];

  const primaryPortName = getPrimaryPortName(
    run.machineDomain,
    run.machineDomains,
    run.primaryPortName,
  );

  return Object.entries(previewUrls)
    .filter(([portName]) => !SYSTEM_PORT_NAMES.has(portName.toUpperCase()))
    .map(([portName, url]) => ({
      serviceName: portName,
      url: appendInitialPath(url, run.initialPaths?.[portName] ?? null),
      isPrimary: portName === primaryPortName,
      runId: run.id,
    }))
    .sort((left, right) => Number(right.isPrimary) - Number(left.isPrimary));
}
