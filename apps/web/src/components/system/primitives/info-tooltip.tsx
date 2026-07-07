'use client';

import { BasicTooltip } from './tooltip';
import { InfoIcon, type LucideIcon } from 'lucide-react';
import { useState } from 'react';

type InfoTooltipProps = {
  content: string;
  icon?: LucideIcon;
  iconClassName?: string;
  contentClassName?: string;
};

export const InfoTooltip = ({
  content,
  icon: Icon = InfoIcon,
  iconClassName,
  contentClassName,
}: InfoTooltipProps) => {
  const [open, setOpen] = useState(false);

  return (
    <BasicTooltip
      content={
        <div className={`max-w-60 text-wrap ${contentClassName}`}>
          {content}
        </div>
      }
      open={open}
      onOpenChange={setOpen}
    >
      <Icon
        className={`inline-block size-3 text-muted-foreground cursor-help ${iconClassName ?? ''}`}
        onTouchEnd={() => setOpen(true)}
      />
    </BasicTooltip>
  );
};
