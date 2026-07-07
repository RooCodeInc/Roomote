import React from 'react';
import { CircleOff } from 'lucide-react';

import { type StateContainerProps, StateContainer } from './StateContainer';

export function EmptyState({
  icon,
  iconClassName = 'text-muted-foreground',
  title,
  description,
  containerClassName,
}: StateContainerProps) {
  return (
    <StateContainer
      icon={icon ?? <CircleOff className="size-6 text-muted-foreground/50" />}
      iconClassName={iconClassName}
      title={title}
      description={description}
      containerClassName={containerClassName}
    />
  );
}
