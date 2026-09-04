'use client';

import type { ReactNode } from 'react';
import { useMediaQuery } from 'usehooks-ts';

import { ArrowLeft, BasicTooltip, Button, X } from '@/components/system';

import { useSandboxLayout } from './use-sandbox-layout';

interface SandboxSidePanelHeaderProps {
  title?: string;
  onClose: () => void;
  closeLabel?: string;
  actions?: ReactNode;
  titleAdornment?: ReactNode;
  onBack?: () => void;
}

export function SandboxSidePanelHeader({
  title,
  onClose,
  closeLabel = 'Close panel',
  actions,
  titleAdornment,
  onBack,
}: SandboxSidePanelHeaderProps) {
  const { isSidebarVisible } = useSandboxLayout();
  const isMdOrLarger = useMediaQuery('(min-width: 768px)', {
    initializeWithValue: false,
  });
  const showCloseButton = isMdOrLarger || !isSidebarVisible;

  return (
    <div className="flex min-w-0 items-center gap-2 border-b-2 border-card px-4 pt-3 pb-2.5">
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
        {onBack ? (
          <BasicTooltip content="Back to list">
            <Button
              variant="ghost"
              size="icon"
              className="size-5 shrink-0 hover:scale-120 hover:text-accent-foreground"
              aria-label="Back to list"
              onClick={onBack}
            >
              <ArrowLeft className="size-3.5" />
            </Button>
          </BasicTooltip>
        ) : null}
        {title ? (
          <div className="min-w-0 flex-1 overflow-hidden">
            <h2
              className="truncate text-sm font-medium whitespace-nowrap"
              title={title}
            >
              {title}
            </h2>
          </div>
        ) : null}
        {titleAdornment ? (
          <div className={title ? 'min-w-0 shrink' : 'min-w-0 flex-1'}>
            {titleAdornment}
          </div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {actions}
        {showCloseButton ? (
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label={closeLabel}
            onClick={onClose}
          >
            <X className="size-4" />
          </Button>
        ) : null}
      </div>
    </div>
  );
}
