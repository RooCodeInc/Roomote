import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';
import { Spinner } from './spinner';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 rounded-lg whitespace-nowrap font-semibold transition-all [&_svg]:pointer-events-none shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-foreground aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive cursor-pointer active:opacity-80 disabled:cursor-default disabled:[&_.animate-spin]:opacity-50',
  {
    variants: {
      variant: {
        default:
          'bg-foreground text-card hover:bg-black/80 hover:text-accent-bright-foreground dark:hover:bg-accent-foreground dark:hover:text-card disabled:bg-foreground/30 disabled:text-foreground/30',
        destructive:
          'bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 disabled:bg-destructive/20',
        outline:
          'border border-foreground/40 bg-transparent hover:bg-accent-foreground dark:hover:bg-transparent dark:hover:border-accent-foreground dark:hover:text-accent-foreground disabled:border-foreground/20 disabled:text-foreground/30',
        'destructive-outline':
          'border border-destructive bg-transparent hover:bg-transparent hover:text-destructive',
        secondary:
          'bg-border text-secondary-foreground bg-card hover:text-accent-foreground disabled:bg-foreground/30 disabled:text-foreground/30',
        ghost:
          'hover:bg-accent hover-not-disabled:text-accent-foreground dark:hover-not-disabled:bg-foreground/20 disabled:text-muted-foreground/50',
        link: '!px-0.5 b text-secondary-foreground hover:text-secondary-foreground/80 underline-offset-4 underline disabled:text-muted-foreground/50 disabled:hover:no-underline',
        bare: 'hover:text-accent-foreground p-0!',
      },
      size: {
        default:
          "text-base h-9 px-4 py-2 [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-5",
        xs: "text-xs h-6 gap-1 px-3 has-[>svg]:pl-2.5 has-[>svg]:pr-3 [&_svg:not([class*='size-'])]:size-3",
        sm: "text-sm h-8 gap-1.5 px-3 has-[>svg]:px-4 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "text-lg h-10 px-8 has-[>svg]:px-4 [&_svg:not([class*='size-'])]:size-6",
        icon: "rounded-full [&_svg:not([class*='size-'])]:size-4 p-1.5",
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

const buttonLoadingSpinnerSizes = {
  default: 'default',
  xs: 'sm',
  sm: 'sm',
  lg: 'default',
  icon: 'default',
} as const;

type ButtonVariantProps = VariantProps<typeof buttonVariants>;

type ButtonAsButtonProps = React.ComponentProps<'button'> &
  ButtonVariantProps & {
    asChild?: false;
    loading?: boolean;
  };

type ButtonAsChildProps = Omit<React.ComponentProps<typeof Slot>, 'children'> &
  ButtonVariantProps & {
    asChild: true;
    children: React.ReactElement;
    loading?: never;
    disabled?: boolean;
  };

type ButtonProps = ButtonAsButtonProps | ButtonAsChildProps;

function Button(props: ButtonProps) {
  const { className, variant, size } = props;
  const buttonClassName = cn(buttonVariants({ variant, size, className }));

  if (props.asChild) {
    if ('loading' in props && props.loading) {
      throw new Error(
        'Button does not support `loading` when `asChild` is true. Render a native button instead.',
      );
    }

    const {
      asChild: _asChild,
      className: _className,
      variant: _variant,
      size: _size,
      loading: _loading,
      children,
      ...slotProps
    } = props as ButtonAsChildProps & { loading?: boolean };

    return (
      <Slot data-slot="button" className={buttonClassName} {...slotProps}>
        {children}
      </Slot>
    );
  }

  const {
    asChild: _asChild,
    className: _className,
    variant: _variant,
    size: _size,
    loading = false,
    disabled,
    children,
    ...buttonProps
  } = props;
  const spinnerSize = buttonLoadingSpinnerSizes[size ?? 'default'];
  const content = loading ? (
    <>
      <Spinner size={spinnerSize} />
      {children}
    </>
  ) : (
    children
  );

  return (
    <button
      data-slot="button"
      className={buttonClassName}
      disabled={disabled || loading}
      {...buttonProps}
    >
      {content}
    </button>
  );
}

export { Button, buttonVariants };
export type { ButtonAsButtonProps };
