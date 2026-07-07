'use client';

import type { ReactNode } from 'react';
import { useMediaQuery } from 'usehooks-ts';

import { ArrowLeft, BasicTooltip, Button, X } from '@/components/system';

import { useSandboxLayout } from '../../../use-sandbox-layout';

interface SidePanelHeaderProps {
  title?: string;
  onClose: () => void;
  /** Optional content rendered between the title and the close button. */
  actions?: ReactNode;
  /** Optional content rendered inline after the title text. */
  titleAdornment?: ReactNode;
  /** When provided, renders a back arrow before the title. */
  onBack?: () => void;
}

export function SidePanelHeader({
  title,
  onClose,
  actions,
  titleAdornment,
  onBack,
}: SidePanelHeaderProps) {
  const { isSidebarVisible } = useSandboxLayout();
  const isMdOrLarger = useMediaQuery('(min-width: 768px)');

  // On desktop: always show close button.
  // On mobile: only show when the sidebar action bar is hidden (escape hatch).
  const showCloseButton = isMdOrLarger || !isSidebarVisible;

  return (
    <div className="flex min-w-0 items-center gap-2 border-b-2 border-card px-4 pt-3 pb-2.5">
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
        {onBack && (
          <BasicTooltip content="Back to list">
            <Button
              variant="ghost"
              size="icon"
              className="size-5 shrink-0 hover:scale-120 hover:text-accent-foreground"
              onClick={onBack}
            >
              <ArrowLeft className="size-3.5" />
            </Button>
          </BasicTooltip>
        )}
        {title && (
          <div className="min-w-0 flex-1 overflow-hidden">
            <h2
              className="truncate text-sm font-medium whitespace-nowrap"
              title={title}
            >
              {title}
            </h2>
          </div>
        )}
        {titleAdornment && (
          <div className="min-w-0 shrink">{titleAdornment}</div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {actions}
        {showCloseButton && (
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            onClick={onClose}
          >
            <X className="size-4" />
          </Button>
        )}
      </div>
    </div>
  );
}
