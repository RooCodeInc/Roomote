import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

const alertVariants = cva(
  'relative w-full rounded-lg px-4 py-3 text-sm flex gap-2 items-start [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:mt-0.75 border border-transparent',
  {
    variants: {
      variant: {
        default:
          'bg-card text-card-foreground dark:bg-foreground/10 outline-1 outline-accent-bright-foreground dark:outline-accent-foreground/70',
        light: 'bg-transparent text-card-foreground border-foreground/10',
        notice: 'bg-accent-foreground text-black',
        warning:
          'bg-warning dark:bg-warning/90 text-warning-foreground [&>svg]:text-current *:data-[slot=alert-description]:text-warning/80',

        destructive:
          'bg-destructive dark:bg-destructive/90 text-destructive-foreground [&>svg]:text-current *:data-[slot=alert-description]:text-destructive/80',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

function flattenAlertChildren(children: React.ReactNode): React.ReactNode[] {
  const flattenedChildren: React.ReactNode[] = [];

  for (const child of React.Children.toArray(children)) {
    if (React.isValidElement(child) && child.type === React.Fragment) {
      flattenedChildren.push(
        ...flattenAlertChildren(
          (child as React.ReactElement<{ children?: React.ReactNode }>).props
            .children,
        ),
      );
      continue;
    }

    flattenedChildren.push(child);
  }

  return flattenedChildren;
}

function Alert({
  className,
  variant,
  children,
  ...props
}: React.ComponentProps<'div'> & VariantProps<typeof alertVariants>) {
  const childArray = flattenAlertChildren(children);
  const textChildren: React.ReactNode[] = [];
  const leadingChildren: React.ReactNode[] = [];
  const trailingChildren: React.ReactNode[] = [];
  let sawTextContent = false;

  for (const child of childArray) {
    if (
      React.isValidElement(child) &&
      (child.type === AlertTitle || child.type === AlertDescription)
    ) {
      textChildren.push(child);
      sawTextContent = true;
      continue;
    }

    if (sawTextContent) {
      trailingChildren.push(child);
      continue;
    }

    leadingChildren.push(child);
  }

  return (
    <div
      data-slot="alert"
      role="alert"
      className={cn(
        alertVariants({ variant }),
        'flex gap-2 flex-row md:gap-3',
        className,
      )}
      {...props}
    >
      {leadingChildren}
      {textChildren.length > 0 ? (
        <div
          data-slot="alert-content"
          className="contents md:flex md:min-w-0 md:flex-1 md:flex-col md:gap-1"
        >
          {textChildren}
        </div>
      ) : null}
      {trailingChildren}
    </div>
  );
}

function AlertTitle({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="alert-title"
      className={cn(
        'line-clamp-1 min-h-4 text-sm font-semibold tracking-tight',
        className,
      )}
      {...props}
    />
  );
}

function AlertDescription({
  className,
  ...props
}: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="alert-description"
      className={cn(
        'flex flex-nowrap gap-2 text-sm [&_p]:leading-relaxed [&>svg]:size-4 [&>svg]:translate-y-0.5 [&>svg]:text-current',
        className,
      )}
      {...props}
    />
  );
}

export { Alert, AlertTitle, AlertDescription };
