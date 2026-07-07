'use client';

import { memo } from 'react';

import { SideNavItem } from '@/components/layout/side-nav/SideNavItem';
import { Badge, FileDiffIcon } from '@/components/system';

interface DiffButtonProps {
  active: boolean;
  onClick: () => void;
  changedFileCount: number;
  isLoading: boolean;
  disabled?: boolean;
}

function DiffButtonBase({
  active,
  onClick,
  changedFileCount,
  isLoading,
  disabled: disabledUntilReady = false,
}: DiffButtonProps) {
  const hasPendingChanges = changedFileCount > 0;
  const isDisabled =
    disabledUntilReady || (!active && !isLoading && !hasPendingChanges);

  return (
    <SideNavItem
      side="right"
      label="Inspect changes"
      tooltip={
        disabledUntilReady
          ? undefined
          : active
            ? 'Inspect changes'
            : isLoading
              ? 'Checking pending changes'
              : hasPendingChanges
                ? 'Inspect changes'
                : 'No pending changes'
      }
      onClick={onClick}
      disabled={isDisabled}
      active={active}
    >
      <FileDiffIcon className="size-5" />
      {hasPendingChanges && (
        <Badge
          variant="default"
          className={
            active
              ? 'absolute -top-1 -right-1 h-5 min-w-5 justify-center bg-card px-1 text-[10px] leading-none text-foreground dark:bg-background dark:text-foreground'
              : 'absolute -top-1 -right-1 h-5 min-w-5 justify-center px-1 text-[10px] leading-none'
          }
        >
          {changedFileCount}
        </Badge>
      )}
    </SideNavItem>
  );
}

export const DiffButton = memo(DiffButtonBase);
