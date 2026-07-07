import React from 'react';
import { CircleX } from 'lucide-react';

import { type StateContainerProps, StateContainer } from './StateContainer';

export function ErrorState({
  icon,
  iconClassName = 'text-destructive',
  title = 'Failed to load',
  description = 'Please try again or check your connection',
}: StateContainerProps) {
  return (
    <StateContainer
      icon={icon ?? <CircleX className="size-6" />}
      iconClassName={iconClassName}
      title={title}
      description={description}
    />
  );
}
