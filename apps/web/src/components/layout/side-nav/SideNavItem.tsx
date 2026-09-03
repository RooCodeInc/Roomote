'use client';

import Link from 'next/link';
import {
  forwardRef,
  type ComponentPropsWithoutRef,
  type ReactElement,
  type ReactNode,
  isValidElement,
} from 'react';
import type { LucideIcon } from '@/components/system';
import type { ButtonAsButtonProps } from '@/components/system/primitives/button';

import { cn } from '@/lib/utils';

import {
  Button,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/components/system';

type SideNavItemProps = Omit<
  ButtonAsButtonProps,
  'asChild' | 'children' | 'loading'
> & {
  asChild?: boolean;
  icon?: LucideIcon;
  children?: ReactNode;
  tooltip?: ReactNode;
  description?: ReactNode;
  label?: string;
  expanded?: boolean;
  href?: string;
  side?: 'left' | 'right';
  active?: boolean;
  isActive?: boolean;
  highlight?: boolean;
  useNativeLink?: boolean;
  linkProps?: Omit<
    ComponentPropsWithoutRef<'a'>,
    'aria-current' | 'aria-label' | 'children' | 'className' | 'href'
  >;
};

export const SideNavItem = forwardRef<HTMLButtonElement, SideNavItemProps>(
  (
    {
      icon: Icon,
      children,
      tooltip,
      description,
      label,
      expanded = false,
      href,
      side = 'left',
      active,
      isActive,
      highlight = false,
      useNativeLink = false,
      linkProps,
      asChild = false,
      disabled = false,
      className,
      type,
      'aria-label': ariaLabel,
      ...props
    },
    ref,
  ) => {
    const resolvedLabel =
      label ?? (typeof tooltip === 'string' ? tooltip : undefined);
    const isLeftSide = side === 'left';
    const isCurrentItem = active ?? isActive ?? false;

    const itemClasses = cn(
      'relative cursor-pointer flex items-center transition-all text-sm',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
      '[&_svg]:size-5 [&_svg]:shrink-0',
      expanded
        ? 'w-full rounded-xl justify-start px-2.5'
        : 'w-9 justify-center rounded-full ',
      disabled &&
        'cursor-not-allowed opacity-50 !bg-transparent hover:!bg-transparent',
      isCurrentItem
        ? '!bg-foreground !text-accent-bright-foreground dark:!bg-accent-foreground dark:!text-card'
        : 'text-foreground hover:text-accent-foreground hover:bg-transparent',
      className,
    );

    const content = (
      <>
        {(children ?? Icon) ? (
          <span className="relative inline-flex shrink-0 items-center justify-center">
            {children ?? (Icon ? <Icon /> : null)}
            {!asChild && highlight ? (
              <span
                className={cn(
                  'pointer-events-none absolute flex size-2',
                  expanded ? '-top-0.5 -right-1' : '-top-0.5 -right-0.5',
                )}
              >
                <span className="absolute inline-flex size-2 animate-ping rounded-full bg-accent-foreground opacity-75" />
                <span className="relative inline-flex size-2 rounded-full bg-accent-foreground" />
              </span>
            ) : null}
          </span>
        ) : null}
        {resolvedLabel ? (
          <span
            className={cn(
              'min-w-0 overflow-hidden transition-all',
              expanded ? 'w-full pl-1 opacity-100' : 'hidden w-0 opacity-0',
            )}
          >
            <span className="block w-full truncate text-left font-medium">
              {resolvedLabel}
            </span>
          </span>
        ) : null}
      </>
    );

    if (asChild && !isValidElement(children)) {
      throw new Error(
        'SideNavItem requires a single React element child when `asChild` is true.',
      );
    }

    const control = asChild ? (
      <Button
        ref={ref}
        variant="ghost"
        asChild
        disabled={disabled}
        className={itemClasses}
        aria-label={ariaLabel ?? (!isLeftSide ? resolvedLabel : undefined)}
        {...props}
      >
        {children as ReactElement}
      </Button>
    ) : href != null && !disabled ? (
      <Button
        ref={ref}
        variant="ghost"
        asChild
        disabled={disabled}
        className={itemClasses}
        aria-label={ariaLabel ?? (!isLeftSide ? resolvedLabel : undefined)}
        {...props}
      >
        {useNativeLink ? (
          <a
            href={href}
            aria-current={isCurrentItem ? 'page' : undefined}
            {...linkProps}
          >
            {content}
          </a>
        ) : (
          <Link
            href={href}
            aria-current={isCurrentItem ? 'page' : undefined}
            {...linkProps}
          >
            {content}
          </Link>
        )}
      </Button>
    ) : (
      <Button
        ref={ref}
        type={type ?? 'button'}
        variant="ghost"
        disabled={disabled}
        className={itemClasses}
        aria-label={ariaLabel ?? (!isLeftSide ? resolvedLabel : undefined)}
        {...props}
      >
        {content}
      </Button>
    );

    if (expanded || !tooltip) {
      return control;
    }

    return (
      <Tooltip delayDuration={400}>
        <TooltipTrigger asChild>{control}</TooltipTrigger>
        <TooltipContent
          side={isLeftSide ? 'right' : 'left'}
          align="center"
          className={`text-sm p-3 pl-4 text-${side}`}
        >
          <p className="font-semibold">{tooltip}</p>
          {description ? <p className="text-muted">{description}</p> : null}
        </TooltipContent>
      </Tooltip>
    );
  },
);

SideNavItem.displayName = 'SideNavItem';
