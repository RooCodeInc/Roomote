'use client';

import { useMemo } from 'react';
import type { TaskRun } from '@roomote/db';

import { AppWindow } from '@/components/system';
import { useRegisterCommands } from '@/components/layout';

import { useTaskSidePanel } from './hooks';
import { usePreviewPane } from './hooks/use-preview-pane';
import { resolvePreviewTarget, usePreviewUrls } from './hooks/use-preview-urls';

interface PreviewCommandProps {
  taskRun: TaskRun | null;
  asleep: boolean;
}

export function PreviewCommand({ taskRun, asleep }: PreviewCommandProps) {
  const { initialPaths, previewUrl, previewUrls, primaryPortName } =
    usePreviewUrls(taskRun ?? {});
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

    if (resolvedPreviewUrl && taskRun?.id) {
      commands.push({
        id: 'task-live-preview',
        icon: AppWindow,
        label: 'Live Preview',
        group: 'Task actions',
        action: () => {
          openPreviewPane(
            resolvedPreviewUrl,
            taskRun.id,
            resolvedPreviewServiceName ?? undefined,
          );
          openPreviewView(
            resolvedPreviewUrl,
            taskRun.id,
            resolvedPreviewServiceName ?? undefined,
          );
        },
        keywords: ['browser', 'live preview', 'preview', 'app'],
      });
    }

    return commands;
  }, [
    asleep,
    taskRun,
    openPreviewPane,
    openPreviewView,
    resolvedPreviewServiceName,
    resolvedPreviewUrl,
  ]);

  useRegisterCommands(cmds);

  return null;
}
