'use client';

import * as CollapsiblePrimitive from '@radix-ui/react-collapsible';
import { ChevronUp, type LucideIcon } from 'lucide-react';

import { cn } from '@/lib/utils';

function Collapsible({
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.Root>) {
  return <CollapsiblePrimitive.Root data-slot="collapsible" {...props} />;
}

function CollapsibleTrigger({
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.CollapsibleTrigger>) {
  return (
    <CollapsiblePrimitive.CollapsibleTrigger
      data-slot="collapsible-trigger"
      {...props}
    />
  );
}

function CollapsibleContent({
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.CollapsibleContent>) {
  return (
    <CollapsiblePrimitive.CollapsibleContent
      data-slot="collapsible-content"
      {...props}
    />
  );
}

interface CollapsibleIconTriggerProps {
  icon: LucideIcon;
  className?: string;
  iconClassName?: string;
}

function CollapsibleIconTrigger({
  icon: Icon,
  className,
  iconClassName,
}: CollapsibleIconTriggerProps) {
  return (
    <span className={cn('relative size-3 shrink-0', className)}>
      <ChevronUp
        className={cn(
          'absolute size-3 transition-all opacity-0 -top-4 group-data-[state=open]:opacity-100 group-data-[state=open]:top-0',
          iconClassName,
        )}
      />
      <Icon
        className={cn(
          'absolute size-3 transition-all opacity-100 top-0 group-data-[state=open]:opacity-0 group-data-[state=open]:top-4',
          iconClassName,
        )}
      />
    </span>
  );
}

export {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
  CollapsibleIconTrigger,
};
