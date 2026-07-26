import { useMemo } from 'react';
import { appendInitialPath } from '@roomote/types';

import type { TaskRun } from '@roomote/db';

import { buildTaskPreviewUrls, getPrimaryPreviewUrlWithPath } from '@/lib';

interface ResolvePreviewTargetParams {
  initialPaths: Record<string, string> | null | undefined;
  previewPath: string | null;
  previewServiceName: string | null;
  previewUrl: string | null;
  previewUrls: Record<string, string> | null;
  primaryPortName: string | null | undefined;
}

interface ResolvedPreviewTarget {
  previewServiceName: string | null;
  previewUrl: string | null;
}

export function resolvePreviewTarget({
  initialPaths,
  previewPath,
  previewServiceName,
  previewUrl,
  previewUrls,
  primaryPortName,
}: ResolvePreviewTargetParams): ResolvedPreviewTarget {
  if (previewServiceName && previewUrls?.[previewServiceName]) {
    return {
      previewServiceName,
      previewUrl: appendInitialPath(
        previewUrls[previewServiceName],
        previewPath ?? initialPaths?.[previewServiceName] ?? null,
      ),
    };
  }

  return {
    previewServiceName: primaryPortName ?? null,
    previewUrl,
  };
}

export function usePreviewUrls({
  taskId,
  machineDomains,
  machineDomain,
  initialPaths,
  primaryPortName,
  previewProxyBaseUrl,
  previewProxySubdomainSuffix,
}: Partial<
  Pick<
    TaskRun,
    | 'taskId'
    | 'machineDomains'
    | 'machineDomain'
    | 'initialPaths'
    | 'primaryPortName'
  >
> & {
  previewProxyBaseUrl?: string | null;
  previewProxySubdomainSuffix?: string | null;
}): {
  previewUrls: Record<string, string> | null;
  previewUrl: string | null;
  initialPaths: Record<string, string> | null | undefined;
  primaryPortName: string | null | undefined;
} {
  const previewUrls = useMemo(
    () =>
      taskId
        ? buildTaskPreviewUrls(
            taskId,
            machineDomains,
            previewProxyBaseUrl,
            previewProxySubdomainSuffix,
          )
        : null,
    [taskId, machineDomains, previewProxyBaseUrl, previewProxySubdomainSuffix],
  );

  const previewUrl = useMemo(
    () =>
      getPrimaryPreviewUrlWithPath(
        previewUrls,
        machineDomain,
        machineDomains,
        initialPaths,
        primaryPortName,
      ),
    [previewUrls, machineDomain, machineDomains, initialPaths, primaryPortName],
  );

  return { previewUrls, previewUrl, initialPaths, primaryPortName };
}
