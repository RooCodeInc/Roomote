'use client';

import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { XIcon } from 'lucide-react';

import { cn } from '@/lib/utils';

function Dialog({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogTrigger({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogPortal({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

function DialogClose({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-dialog bg-black/50',
        className,
      )}
      {...props}
    />
  );
}

const dialogSizes = {
  sm: 'md:max-w-sm',
  md: 'md:max-w-md',
  lg: 'md:max-w-lg',
  xl: 'md:max-w-xl',
  '2xl': 'md:max-w-2xl',
  '3xl': 'md:max-w-3xl',
  '4xl': 'md:max-w-4xl',
  max: 'md:max-w-[calc(100vw-5rem)]',
} as const;

function DialogContent({
  className,
  children,
  overlayClassName,
  showCloseButton = true,
  size = 'md',
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  overlayClassName?: string;
  showCloseButton?: boolean;
  size?: keyof typeof dialogSizes;
}) {
  const contentRef = React.useRef<HTMLDivElement>(null);

  return (
    <DialogPortal data-slot="dialog-portal">
      <DialogOverlay className={overlayClassName} />
      <DialogPrimitive.Content
        ref={contentRef}
        onPointerDownOutside={(e) => {
          // Detect if click actually happened within the bounds of content.
          // This can happen if click was on an absolutely positioned element overlapping content,
          // such as the 1password extension icon in the text input.
          // See: https://github.com/radix-ui/primitives/issues/1280#issuecomment-1319109163
          if (contentRef.current) {
            const contentRect = contentRef.current.getBoundingClientRect();
            const actuallyClickedInside =
              e.detail.originalEvent.clientX > contentRect.left &&
              e.detail.originalEvent.clientX <
                contentRect.left + contentRect.width &&
              e.detail.originalEvent.clientY > contentRect.top &&
              e.detail.originalEvent.clientY <
                contentRect.top + contentRect.height;

            if (actuallyClickedInside) {
              e.preventDefault();
            }
          }
          props.onPointerDownOutside?.(e);
        }}
        data-slot="dialog-content"
        className={cn(
          // Mobile: Bottom sheet with rounded top corners
          'fixed inset-x-0 bottom-0 z-dialog grid w-full gap-4 border-t border-x bg-background p-6 shadow-lg',
          // Scrollable by default
          'max-h-[calc(var(--effective-viewport-height)-3rem)] md:max-h-[calc(var(--effective-viewport-height)-5rem)] overflow-y-auto',
          // Mobile animations
          'data-[state=open]:animate-in data-[state=closed]:animate-out',
          'data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom',
          'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
          // Desktop: Centered modal
          'md:inset-auto md:bottom-auto md:left-[50%] md:top-[50%] md:min-w-lg md:translate-x-[-50%] md:translate-y-[-50%] md:rounded-lg md:border',
          dialogSizes[size],
          // Desktop animations
          'md:data-[state=closed]:zoom-out-95 md:data-[state=open]:zoom-in-95',
          'duration-200',
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            className={cn(
              "ring-offset-background focus:ring-ring data-[state=open]:bg-accent data-[state=open]:text-muted-foreground absolute top-4 right-4 opacity-70 transition-opacity hover:opacity-100 focus:ring-2 focus:ring-offset-2 focus:outline-hidden disabled:pointer-events-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
              'cursor-pointer active:opacity-80',
            )}
          >
            <XIcon />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="dialog-header"
      className={cn('flex flex-col gap-2', className)}
      {...props}
    />
  );
}

function DialogFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        'flex flex-col-reverse gap-2 md:flex-row md:justify-end',
        className,
      )}
      {...props}
    />
  );
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn('text-lg leading-none font-semibold', className)}
      {...props}
    />
  );
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn('text-muted-foreground text-sm text-left', className)}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
};
