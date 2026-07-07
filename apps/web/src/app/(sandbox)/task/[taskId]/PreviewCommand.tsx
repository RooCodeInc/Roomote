'use client';

import { useMemo } from 'react';
import type { CloudJob } from '@roomote/db';

import { AppWindow } from '@/components/system';
import { useRegisterCommands } from '@/components/layout';

import { useTaskSidePanel } from './hooks';
import { usePreviewPane } from './hooks/use-preview-pane';
import { resolvePreviewTarget, usePreviewUrls } from './hooks/use-preview-urls';

interface PreviewCommandProps {
  cloudJob: CloudJob | null;
  asleep: boolean;
}

export function PreviewCommand({ cloudJob, asleep }: PreviewCommandProps) {
  const { initialPaths, previewUrl, previewUrls, primaryPortName } =
    usePreviewUrls(cloudJob ?? {});
  const { openPreviewView, previewPath, previewServiceName } =
    useTaskSidePanel();
  const { openPreviewPane } = usePreviewPane();
  const {
    previewServiceName: resolvedPreviewServiceName,
    previewUrl: resolvedPreviewUrl,
  } = resolvePreviewTarget({
    initialPaths,
    previewPath,
    previewServiceName,
    previewUrl,
    previewUrls,
    primaryPortName,
  });

  const cmds = useMemo(() => {
    if (asleep) {
      return [];
    }

    const commands: Parameters<typeof useRegisterCommands>[0] = [];

    if (resolvedPreviewUrl && cloudJob?.id) {
      commands.push({
        id: 'task-live-preview',
        icon: AppWindow,
        label: 'Live Preview',
        group: 'Task actions',
        action: () => {
          openPreviewPane(
            resolvedPreviewUrl,
            cloudJob.id,
            resolvedPreviewServiceName ?? undefined,
          );
          openPreviewView(
            resolvedPreviewUrl,
            cloudJob.id,
            resolvedPreviewServiceName ?? undefined,
          );
        },
        keywords: ['browser', 'live preview', 'preview', 'app'],
      });
    }

    return commands;
  }, [
    asleep,
    cloudJob,
    openPreviewPane,
    openPreviewView,
    resolvedPreviewServiceName,
    resolvedPreviewUrl,
  ]);

  useRegisterCommands(cmds);

  return null;
}
