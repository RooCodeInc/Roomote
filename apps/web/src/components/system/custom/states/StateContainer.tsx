import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

export interface StateContainerProps {
  icon?: ReactNode;
  iconClassName?: string;
  title?: ReactNode;
  description?: ReactNode;
  containerClassName?: string;
}

export function StateContainer({
  icon,
  iconClassName,
  title,
  description,
  containerClassName,
}: StateContainerProps) {
  return (
    <div className={cn('p-6 rounded-2xl', containerClassName)}>
      <div className="flex flex-row gap-4">
        {icon && (
          <div className={cn('flex items-start pt-1', iconClassName)}>
            {icon}
          </div>
        )}
        <div className="space-y-0.5">
          {title && (
            <div className="text-base font-semibold text-foreground">
              {title}
            </div>
          )}
          {description && (
            <div className="text-sm text-muted-foreground">{description}</div>
          )}
        </div>
      </div>
    </div>
  );
}
