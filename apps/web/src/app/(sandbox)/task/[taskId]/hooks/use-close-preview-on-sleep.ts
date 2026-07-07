'use client';

import { useEffect } from 'react';

import { usePreviewPane } from './use-preview-pane';
import { useTaskSidePanel } from './use-task-side-panel';

export function useClosePreviewOnSleep(asleep: boolean) {
  const { closePreviewPane } = usePreviewPane();
  const { closeSidePanel, isViewActive } = useTaskSidePanel();

  useEffect(() => {
    const isSleepClosableView = isViewActive('preview');

    if (!asleep || !isSleepClosableView) {
      return;
    }

    closePreviewPane();
    closeSidePanel();
  }, [asleep, closePreviewPane, closeSidePanel, isViewActive]);
}
