'use client';

import { memo } from 'react';

import { Logs } from '@/components/system';
import { SideNavItem } from '@/components/layout/side-nav/SideNavItem';

import { useLogFiles, useTaskSidePanel } from '../hooks';

import type { SidebarActionBaseProps } from './types';

function LogsButtonBase({ cloudJob }: SidebarActionBaseProps) {
  const logfiles = useLogFiles();
  const { openLogsView, closeSidePanel, isViewActive } = useTaskSidePanel();

  if (!cloudJob) {
    return null;
  }

  const hasLogs = logfiles.length > 0;
  const logsViewActive = isViewActive('logs');

  return (
    <SideNavItem
      side="right"
      label="Logs"
      tooltip={hasLogs ? 'Logs' : 'No logs available'}
      active={hasLogs && logsViewActive}
      disabled={!hasLogs}
      onClick={
        hasLogs
          ? () => (logsViewActive ? closeSidePanel() : openLogsView())
          : undefined
      }
      icon={Logs}
    />
  );
}

export const LogsButton = memo(LogsButtonBase);
