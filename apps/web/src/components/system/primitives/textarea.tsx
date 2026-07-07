import * as React from 'react';

import { cn } from '@/lib/utils';

function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return (
    <textarea
      data-slot="textarea"
      data-1p-ignore
      data-op-ignore="true"
      className={cn(
        'field-sizing-content bg-card border border-input min-h-16 w-full flex rounded-lg px-3 py-2 text-sm shadow-xs transition-[color,box-shadow,border,background] outline-none',
        'selection:bg-primary selection:text-primary-foreground',
        'placeholder:text-muted-foreground/70',
        'disabled:cursor-not-allowed disabled:bg-foreground/5 disabled:text-foreground/50',
        'focus-visible:border-foreground/60',
        'file:text-foreground file:inline-flex file:h-7 file:border-0 file:border-r file:border-border file:bg-transparent file:font-medium file:mr-2 file:pr-2',
        'aria-invalid:ring-2 aria-invalid:ring-destructive/50',
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
