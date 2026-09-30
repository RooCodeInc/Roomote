import * as React from 'react';
import * as TogglePrimitive from '@radix-ui/react-toggle';
import { type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

import { buttonVariants } from './button';

type ToggleButtonVariant = 'ghost' | 'outline';
type ToggleButtonSize = NonNullable<
  VariantProps<typeof buttonVariants>['size']
>;

type ToggleButtonProps = Omit<
  React.ComponentPropsWithoutRef<typeof TogglePrimitive.Root>,
  'className'
> & {
  className?: string;
  variant?: ToggleButtonVariant;
  size?: ToggleButtonSize;
};

const ToggleButton = React.forwardRef<HTMLButtonElement, ToggleButtonProps>(
  (
    {
      className,
      type = 'button',
      variant = 'ghost',
      size = 'default',
      ...props
    },
    ref,
  ) => (
    <TogglePrimitive.Root
      ref={ref}
      type={type}
      data-slot="toggle-button"
      className={cn(
        buttonVariants({ variant, size }),
        variant === 'ghost'
          ? 'border border-transparent'
          : 'data-[state=on]:border-accent-foreground',
        'data-[state=on]:bg-accent-foreground data-[state=on]:text-black',
        className,
      )}
      {...props}
    />
  ),
);
ToggleButton.displayName = TogglePrimitive.Root.displayName;

export { ToggleButton };
