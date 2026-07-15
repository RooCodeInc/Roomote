'use client';

import * as React from 'react';
import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';
import { Slot } from '@radix-ui/react-slot';
import { useControllableState } from '@radix-ui/react-use-controllable-state';
import { CheckIcon, ChevronRightIcon, CircleIcon } from 'lucide-react';
import { cva, type VariantProps } from 'class-variance-authority';

import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerTitle,
  DrawerTrigger,
} from './drawer';
import { Tooltip, TooltipContent, TooltipTrigger } from './tooltip';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from './collapsible';
import { useIsMobile } from '@/hooks/useIsMobile';
import { cn } from '@/lib/utils';

type DropdownMenuContextValue = {
  isMobile: boolean;
  open: boolean;
  setOpen: (open: boolean) => void;
};

const DropdownMenuContext = React.createContext<DropdownMenuContextValue>({
  isMobile: false,
  open: false,
  setOpen: () => {},
});

type DropdownMenuRadioGroupContextValue = {
  value?: string;
  onValueChange?: (value: string) => void;
};

const DropdownMenuRadioGroupContext =
  React.createContext<DropdownMenuRadioGroupContextValue>({});

function DropdownMenu({
  open: openProp,
  defaultOpen,
  onOpenChange,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Root>) {
  const isMobile = useIsMobile();
  const [open, setOpen] = useControllableState({
    prop: openProp,
    defaultProp: defaultOpen ?? false,
    onChange: onOpenChange,
  });
  const contextValue = React.useMemo(
    () => ({ isMobile, open: !!open, setOpen }),
    [isMobile, open, setOpen],
  );

  if (isMobile) {
    return (
      <DropdownMenuContext.Provider value={contextValue}>
        <Drawer
          data-slot="dropdown-menu"
          direction="bottom"
          open={open}
          onOpenChange={setOpen}
        >
          {props.children}
        </Drawer>
      </DropdownMenuContext.Provider>
    );
  }

  return (
    <DropdownMenuContext.Provider value={contextValue}>
      <DropdownMenuPrimitive.Root
        data-slot="dropdown-menu"
        open={open}
        onOpenChange={setOpen}
        {...props}
      />
    </DropdownMenuContext.Provider>
  );
}

const dropdownMenuTriggerVariants = cva('rounded-lg', {
  variants: {
    variant: {
      default: '',
      ghost: 'px-1',
    },
  },
  defaultVariants: {
    variant: 'default',
  },
});

function DropdownMenuTrigger({
  className,
  variant,
  tooltip,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Trigger> &
  VariantProps<typeof dropdownMenuTriggerVariants> & {
    tooltip?: string;
  }) {
  const { isMobile } = React.useContext(DropdownMenuContext);

  const trigger = isMobile ? (
    <DrawerTrigger
      data-slot="dropdown-menu-trigger"
      data-variant={variant ?? 'default'}
      className={cn(dropdownMenuTriggerVariants({ variant, className }))}
      {...props}
    />
  ) : (
    <DropdownMenuPrimitive.Trigger
      data-slot="dropdown-menu-trigger"
      data-variant={variant ?? 'default'}
      className={cn(dropdownMenuTriggerVariants({ variant, className }))}
      {...props}
    />
  );

  if (tooltip) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{trigger}</TooltipTrigger>
        <TooltipContent>
          <p>{tooltip}</p>
        </TooltipContent>
      </Tooltip>
    );
  }

  return trigger;
}

function DropdownMenuContent({
  className,
  sideOffset = 4,
  portalContainer,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Content> & {
  portalContainer?: HTMLElement | null;
}) {
  const { isMobile } = React.useContext(DropdownMenuContext);
  if (isMobile) {
    return (
      <DrawerContent
        data-slot="dropdown-menu-content"
        overlayClassName="z-popover"
        className={cn(
          'z-popover bg-popover text-popover-foreground px-0 pb-2 pt-1',
          className,
          'data-[vaul-drawer-direction=bottom]:w-full data-[vaul-drawer-direction=bottom]:max-w-none data-[vaul-drawer-direction=bottom]:max-h-[80vh]',
        )}
      >
        <DrawerTitle className="sr-only">Menu</DrawerTitle>
        <DrawerDescription className="sr-only">
          Choose an option from the menu.
        </DrawerDescription>
        <div className="max-h-[80vh] overflow-y-auto p-2">{props.children}</div>
      </DrawerContent>
    );
  }
  return (
    <DropdownMenuPrimitive.Portal container={portalContainer ?? undefined}>
      <DropdownMenuPrimitive.Content
        data-slot="dropdown-menu-content"
        sideOffset={sideOffset}
        className={cn(
          'bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-popover max-h-(--radix-dropdown-menu-content-available-height) min-w-[8rem] origin-(--radix-dropdown-menu-content-transform-origin) overflow-x-hidden overflow-y-auto scroll-thin rounded-lg border border-input p-1',
          className,
        )}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
}

function DropdownMenuGroup({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Group>) {
  const { isMobile } = React.useContext(DropdownMenuContext);
  if (isMobile) {
    return <div data-slot="dropdown-menu-group" {...props} />;
  }
  return (
    <DropdownMenuPrimitive.Group data-slot="dropdown-menu-group" {...props} />
  );
}

function DropdownMenuItem({
  className,
  inset,
  variant = 'default',
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Item> & {
  inset?: boolean;
  variant?: 'default' | 'destructive';
}) {
  const { isMobile, setOpen } = React.useContext(DropdownMenuContext);
  if (isMobile) {
    const { asChild, disabled, onClick, onSelect, children, ...itemProps } =
      props;
    const Component = (asChild ? Slot : 'button') as React.ElementType;
    const handleClick = (event: React.MouseEvent<HTMLElement>) => {
      if (disabled) {
        event.preventDefault();
        return;
      }
      onClick?.(event as unknown as React.MouseEvent<HTMLDivElement>);
      onSelect?.(event as unknown as Event);
      if (!event.defaultPrevented) {
        setOpen(false);
      }
    };
    return (
      <Component
        data-slot="dropdown-menu-item"
        data-inset={inset}
        data-variant={variant}
        className={cn(
          'focus:bg-accent focus:text-accent-foreground',
          'data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive data-[variant=destructive]:focus:text-white data-[variant=destructive]:*:[svg]:!text-destructive',
          'dark:data-[variant=destructive]:text-destructive dark:',
          "[&_svg:not([class*='text-'])]:text-muted-foreground relative flex cursor-default items-center gap-1 px-2 py-1.5 text-base md:text-sm outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[inset]:pl-8 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
          'rounded-lg cursor-pointer active:opacity-80',
          'group overflow-visible',
          'first:rounded-t-lg last:rounded-b-lg',
          'transition-colors duration-50',
          'w-full',
          className,
        )}
        onClick={handleClick as React.MouseEventHandler<HTMLElement>}
        aria-disabled={disabled}
        {...(!asChild ? { type: 'button' } : {})}
        {...(itemProps as Record<string, unknown>)}
      >
        {children}
      </Component>
    );
  }
  return (
    <DropdownMenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-inset={inset}
      data-variant={variant}
      className={cn(
        "focus:bg-accent-foreground focus:text-black focus:[&_svg]:text-current! [&_svg:not([class*='text-'])]:text-muted-foreground relative flex cursor-default items-center gap-2 px-2 py-1.5 text-base md:text-sm outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[inset]:pl-8 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        'data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive data-[variant=destructive]:focus:text-white data-[variant=destructive]:*:[svg]:text-destructive! data-[variant=destructive]:focus:*:[svg]:text-white!',
        'rounded-lg cursor-pointer active:opacity-80',
        'group overflow-visible',
        'first:rounded-t-lg last:rounded-b-lg',
        'transition-all duration-50',
        className,
      )}
      {...props}
    />
  );
}

function DropdownMenuCheckboxItem({
  className,
  children,
  checked,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.CheckboxItem>) {
  const { isMobile, setOpen } = React.useContext(DropdownMenuContext);
  if (isMobile) {
    const {
      asChild,
      disabled,
      onClick,
      onSelect,
      onCheckedChange,
      ...itemProps
    } = props;
    const Component = (asChild ? Slot : 'button') as React.ElementType;
    const isChecked = checked === true || checked === 'indeterminate';
    const handleClick = (event: React.MouseEvent<HTMLElement>) => {
      if (disabled) {
        event.preventDefault();
        return;
      }
      onClick?.(event as unknown as React.MouseEvent<HTMLDivElement>);
      onSelect?.(event as unknown as Event);
      onCheckedChange?.(isChecked ? false : true);
      if (!event.defaultPrevented) {
        setOpen(false);
      }
    };
    return (
      <Component
        data-slot="dropdown-menu-checkbox-item"
        className={cn(
          "focus:bg-accent focus:text-accent-foreground relative flex w-full cursor-default items-center gap-2 rounded-lg py-1.5 pl-2 pr-8 text-left text-base md:text-sm outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
          className,
        )}
        onClick={handleClick as React.MouseEventHandler<HTMLElement>}
        aria-checked={isChecked}
        role="menuitemcheckbox"
        {...(!asChild ? { type: 'button' } : {})}
        {...(itemProps as Record<string, unknown>)}
      >
        {children}
        <span className="pointer-events-none absolute right-2 flex size-3.5 items-center justify-center">
          {isChecked && <CheckIcon className="size-4" />}
        </span>
      </Component>
    );
  }
  return (
    <DropdownMenuPrimitive.CheckboxItem
      data-slot="dropdown-menu-checkbox-item"
      className={cn(
        "focus:bg-accent focus:text-accent-foreground relative flex w-full cursor-default items-center gap-2 rounded-lg py-1.5 pl-2 pr-8 text-left text-base md:text-sm outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      checked={checked}
      {...props}
    >
      {children}
      <span className="pointer-events-none absolute right-2 flex size-3.5 items-center justify-center">
        <DropdownMenuPrimitive.ItemIndicator>
          <CheckIcon className="size-4" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
    </DropdownMenuPrimitive.CheckboxItem>
  );
}

function DropdownMenuRadioGroup({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.RadioGroup>) {
  const { isMobile } = React.useContext(DropdownMenuContext);
  if (isMobile) {
    return (
      <DropdownMenuRadioGroupContext.Provider
        value={{
          value: props.value as string | undefined,
          onValueChange: props.onValueChange,
        }}
      >
        <div data-slot="dropdown-menu-radio-group" role="radiogroup">
          {props.children}
        </div>
      </DropdownMenuRadioGroupContext.Provider>
    );
  }
  return (
    <DropdownMenuPrimitive.RadioGroup
      data-slot="dropdown-menu-radio-group"
      {...props}
    />
  );
}

function DropdownMenuRadioItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.RadioItem>) {
  const { isMobile, setOpen } = React.useContext(DropdownMenuContext);
  const radioGroup = React.useContext(DropdownMenuRadioGroupContext);
  if (isMobile) {
    const { disabled, onClick, onSelect, value, asChild, ...itemProps } = props;
    const isChecked = radioGroup.value === value;
    const Component = (asChild ? Slot : 'button') as React.ElementType;
    const handleClick = (event: React.MouseEvent<HTMLElement>) => {
      if (disabled) {
        event.preventDefault();
        return;
      }
      onClick?.(event as unknown as React.MouseEvent<HTMLDivElement>);
      onSelect?.(event as unknown as Event);
      if (typeof value === 'string') {
        radioGroup.onValueChange?.(value);
      }
      if (!event.defaultPrevented) {
        setOpen(false);
      }
    };
    return (
      <Component
        data-slot="dropdown-menu-radio-item"
        className={cn(
          "focus:bg-accent focus:text-accent-foreground relative flex cursor-default items-center gap-2 rounded-lg py-1.5 pr-2 pl-8 text-base md:text-sm outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
          className,
        )}
        onClick={handleClick as React.MouseEventHandler<HTMLElement>}
        aria-checked={isChecked}
        role="menuitemradio"
        {...(!asChild ? { type: 'button' } : {})}
        {...(itemProps as Record<string, unknown>)}
      >
        <span className="pointer-events-none absolute left-2 flex size-3.5 items-center justify-center">
          {isChecked && <CircleIcon className="size-2 fill-current" />}
        </span>
        {children}
      </Component>
    );
  }
  return (
    <DropdownMenuPrimitive.RadioItem
      data-slot="dropdown-menu-radio-item"
      className={cn(
        "focus:bg-accent focus:text-accent-foreground relative flex cursor-default items-center gap-2 rounded-lg py-1.5 pr-2 pl-8 text-base md:text-sm outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    >
      <span className="pointer-events-none absolute left-2 flex size-3.5 items-center justify-center">
        <DropdownMenuPrimitive.ItemIndicator>
          <CircleIcon className="size-2 fill-current" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.RadioItem>
  );
}

function DropdownMenuLabel({
  className,
  inset,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Label> & {
  inset?: boolean;
}) {
  const { isMobile } = React.useContext(DropdownMenuContext);
  if (isMobile) {
    return (
      <div
        data-slot="dropdown-menu-label"
        data-inset={inset}
        className={cn(
          'px-2 py-1.5 text-xs font-medium data-[inset]:pl-8 cursor-default mt-2 text-muted-foreground',
          className,
        )}
        {...props}
      />
    );
  }
  return (
    <DropdownMenuPrimitive.Label
      data-slot="dropdown-menu-label"
      data-inset={inset}
      className={cn(
        'px-2 py-1.5 text-xs font-medium data-[inset]:pl-8 cursor-default mt-2 text-muted-foreground',
        className,
      )}
      {...props}
    />
  );
}

function DropdownMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
  const { isMobile } = React.useContext(DropdownMenuContext);
  if (isMobile) {
    return (
      <div
        data-slot="dropdown-menu-separator"
        className={cn('bg-input -mx-1 my-1 h-px', className)}
        {...props}
      />
    );
  }
  return (
    <DropdownMenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      className={cn('bg-input -mx-1 my-1 h-px', className)}
      {...props}
    />
  );
}

function DropdownMenuShortcut({
  className,
  ...props
}: React.ComponentProps<'span'>) {
  return (
    <span
      data-slot="dropdown-menu-shortcut"
      className={cn(
        'text-muted-foreground ml-auto text-xs tracking-widest',
        className,
      )}
      {...props}
    />
  );
}

function DropdownMenuSub({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Sub>) {
  const { isMobile } = React.useContext(DropdownMenuContext);
  if (isMobile) {
    return (
      <Collapsible data-slot="dropdown-menu-sub" {...props}>
        {props.children}
      </Collapsible>
    );
  }
  return <DropdownMenuPrimitive.Sub data-slot="dropdown-menu-sub" {...props} />;
}

function DropdownMenuSubTrigger({
  className,
  inset,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubTrigger> & {
  inset?: boolean;
}) {
  const { isMobile } = React.useContext(DropdownMenuContext);
  if (isMobile) {
    const { asChild, disabled, onClick } = props;
    return (
      <CollapsibleTrigger
        data-slot="dropdown-menu-sub-trigger"
        data-inset={inset}
        className={cn(
          'group focus:bg-accent focus:text-accent-foreground data-[state=open]:bg-accent data-[state=open]:text-accent-foreground flex w-full cursor-default items-center rounded-lg px-2 py-1.5 text-base md:text-sm outline-hidden select-none data-[inset]:pl-8',
          className,
        )}
        asChild={asChild}
        disabled={disabled}
        onClick={
          onClick as unknown as React.MouseEventHandler<HTMLButtonElement>
        }
      >
        {children}
        <ChevronRightIcon className="ml-auto size-4 transition-transform group-data-[state=open]:rotate-90" />
      </CollapsibleTrigger>
    );
  }
  return (
    <DropdownMenuPrimitive.SubTrigger
      data-slot="dropdown-menu-sub-trigger"
      data-inset={inset}
      className={cn(
        'focus:bg-accent focus:text-accent-foreground data-[state=open]:bg-accent data-[state=open]:text-accent-foreground flex cursor-default items-center rounded-lg px-2 py-1.5 text-base md:text-sm outline-hidden select-none data-[inset]:pl-8',
        className,
      )}
      {...props}
    >
      {children}
      <ChevronRightIcon className="ml-auto size-4" />
    </DropdownMenuPrimitive.SubTrigger>
  );
}

function DropdownMenuSubContent({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubContent>) {
  const { isMobile } = React.useContext(DropdownMenuContext);
  if (isMobile) {
    return (
      <CollapsibleContent
        data-slot="dropdown-menu-sub-content"
        className={cn('pl-4 pr-2 pb-1', className)}
        {...props}
      />
    );
  }
  return (
    <DropdownMenuPrimitive.SubContent
      data-slot="dropdown-menu-sub-content"
      className={cn(
        'bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-popover max-h-(--radix-dropdown-menu-content-available-height) min-w-[8rem] origin-(--radix-dropdown-menu-content-transform-origin) overflow-x-hidden overflow-y-auto scroll-thin rounded-lg border border-input p-1 ',
        className,
      )}
      {...props}
    />
  );
}

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
};
