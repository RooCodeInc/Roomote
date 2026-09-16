'use client';

import { memo } from 'react';

import { SHARED_DESKTOP_NAMED_PORT } from '@roomote/types';

import { SideNavItem } from '@/components/layout/side-nav/SideNavItem';
import { Video } from '@/components/system';

import { usePreviewUrls } from '../hooks/use-preview-urls';
import { useTaskSidePanel } from '../hooks/use-task-side-panel';

import type { SidebarActionBaseProps } from './types';

function SharedDesktopButtonBase({
  taskRun,
  disabled = false,
}: SidebarActionBaseProps & { disabled?: boolean }) {
  const { previewUrls } = usePreviewUrls(taskRun ?? {});
  const { closeSidePanel, isViewActive, openSharedDesktopView } =
    useTaskSidePanel();
  const desktopUrl = previewUrls?.[SHARED_DESKTOP_NAMED_PORT.name];

  if (!taskRun?.payload?.environmentId || !desktopUrl) {
    return null;
  }

  return (
    <SideNavItem
      side="right"
      label="Shared Desktop"
      tooltip="Shared Desktop"
      description="View and control this task's sandbox desktop"
      active={!disabled && isViewActive('shared-desktop')}
      disabled={disabled}
      onClick={
        disabled
          ? undefined
          : () =>
              isViewActive('shared-desktop')
                ? closeSidePanel()
                : openSharedDesktopView()
      }
      icon={Video}
    />
  );
}

export const SharedDesktopButton = memo(SharedDesktopButtonBase);
