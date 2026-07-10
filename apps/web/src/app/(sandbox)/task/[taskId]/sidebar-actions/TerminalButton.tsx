'use client';

import { memo } from 'react';

import { Terminal } from '@/components/system';
import { SideNavItem } from '@/components/layout/side-nav/SideNavItem';

import { useTaskSidePanel } from '../hooks';

import type { SidebarActionBaseProps } from './types';

function TerminalButtonBase({ taskRun }: SidebarActionBaseProps) {
  const { openTerminalView, closeSidePanel, isViewActive } = useTaskSidePanel();

  if (!taskRun) {
    return null;
  }

  return (
    <SideNavItem
      side="right"
      label="Terminal"
      tooltip="Terminal"
      active={isViewActive('terminal')}
      onClick={() =>
        isViewActive('terminal') ? closeSidePanel() : openTerminalView()
      }
      icon={Terminal}
    />
  );
}

export const TerminalButton = memo(TerminalButtonBase);
