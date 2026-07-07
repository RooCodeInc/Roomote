import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

const cardVariants = cva(
  'bg-card text-card-foreground flex flex-col gap-2 rounded-lg px-5 border border-input/50',
  {
    variants: {
      variant: {
        default: 'gap-6 py-6',
        snug: 'gap-3 py-4',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

function Card({
  className,
  variant,
  ...props
}: React.ComponentProps<'div'> & VariantProps<typeof cardVariants>) {
  return (
    <div
      data-slot="card"
      className={cn(cardVariants({ variant, className }))}
      {...props}
    />
  );
}

function CardHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        'grid auto-rows-min grid-rows-[auto_auto] items-start has-data-[slot=card-action]:grid-cols-[1fr_auto] [.border-b]:pb-4 [.border-b]:px-5 [.border-b]:-mx-5 space-y-2',
        className,
      )}
      {...props}
    />
  );
}

function CardTitle({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-title"
      className={cn('leading-none font-semibold', className)}
      {...props}
    />
  );
}

function CardDescription({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-description"
      className={cn('text-muted-foreground text-sm', className)}
      {...props}
    />
  );
}

function CardAction({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-action"
      className={cn(
        'col-start-2 row-span-2 row-start-1 self-start justify-self-end',
        className,
      )}
      {...props}
    />
  );
}

function CardContent({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-content"
      className={cn('text-sm space-y-4', className)}
      {...props}
    />
  );
}

function CardFooter({
  className,
  align,
  ...props
}: React.ComponentProps<'div'> & {
  align?: 'start' | 'center' | 'end' | 'between';
}) {
  return (
    <div
      data-slot="card-footer"
      className={cn(
        'flex items-center gap-2 [.border-t]:pt-3 [.border-t]:px-3 [.border-t]:-mx-5',
        {
          'justify-start': align === 'start',
          'justify-center': align === 'center',
          'justify-end': align === 'end',
          'justify-between': align === 'between',
        },
        className,
      )}
      {...props}
    />
  );
}

export {
  Card,
  CardHeader,
  CardFooter,
  CardTitle,
  CardAction,
  CardDescription,
  CardContent,
};
