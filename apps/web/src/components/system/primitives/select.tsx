'use client';

import * as React from 'react';
import * as SelectPrimitive from '@radix-ui/react-select';
import { useControllableState } from '@radix-ui/react-use-controllable-state';
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  ChevronsUpDown,
} from 'lucide-react';

import { cn } from '@/lib/utils';

type SelectFocusTarget = HTMLInputElement | HTMLTextAreaElement;

export type SelectHandoffTarget = {
  focusAndOpen: () => boolean;
};

type SelectHandoffDestination = SelectFocusTarget | SelectHandoffTarget;

type SelectFocusContextValue = {
  clearSelection: () => void;
  handoffTargetOnSelect?: React.RefObject<SelectHandoffDestination | null>;
  markSelection: () => void;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  takeSelection: () => boolean;
};

const SelectFocusContext = React.createContext<SelectFocusContextValue | null>(
  null,
);

const TEXT_INPUT_TYPES = new Set([
  'email',
  'number',
  'password',
  'search',
  'tel',
  'text',
  'url',
]);

function isVisibleEditableTextField(
  target: SelectFocusTarget,
): target is SelectFocusTarget {
  if (
    !target.isConnected ||
    target.disabled ||
    target.readOnly ||
    target.closest('[hidden], [inert], [aria-hidden="true"]') ||
    target.getClientRects().length === 0
  ) {
    return false;
  }

  if (
    target instanceof HTMLInputElement &&
    !TEXT_INPUT_TYPES.has(target.type)
  ) {
    return false;
  }

  const style = getComputedStyle(target);
  return style.display !== 'none' && style.visibility !== 'hidden';
}

function isAvailableSelectTrigger(
  trigger: HTMLButtonElement | null,
): trigger is HTMLButtonElement {
  if (
    !trigger?.isConnected ||
    trigger.disabled ||
    trigger.getAttribute('aria-disabled') === 'true' ||
    trigger.closest('[hidden], [inert], [aria-hidden="true"]') ||
    trigger.getClientRects().length === 0
  ) {
    return false;
  }

  const style = getComputedStyle(trigger);
  return style.display !== 'none' && style.visibility !== 'hidden';
}

function setRef<T>(ref: React.Ref<T> | undefined, value: T | null) {
  if (typeof ref === 'function') ref(value);
  else if (ref) ref.current = value;
}

function Select({
  defaultOpen,
  disabled,
  handoffRef,
  handoffTargetOnSelect,
  onOpenChange,
  open: openProp,
  ...rootProps
}: React.ComponentProps<typeof SelectPrimitive.Root> & {
  handoffRef?: React.Ref<SelectHandoffTarget>;
  handoffTargetOnSelect?: React.RefObject<SelectHandoffDestination | null>;
}) {
  const [open, setOpen] = useControllableState({
    prop: openProp,
    defaultProp: defaultOpen ?? false,
    onChange: onOpenChange,
    caller: 'Select',
  });
  const selectionCommittedRef = React.useRef(false);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const focusContext: SelectFocusContextValue = {
    handoffTargetOnSelect,
    triggerRef,
    markSelection: () => {
      selectionCommittedRef.current = true;
    },
    clearSelection: () => {
      selectionCommittedRef.current = false;
    },
    takeSelection: () => {
      const selectionCommitted = selectionCommittedRef.current;
      selectionCommittedRef.current = false;
      return selectionCommitted;
    },
  };

  React.useImperativeHandle(handoffRef, () => ({
    focusAndOpen: () => {
      const trigger = triggerRef.current;
      if (!isAvailableSelectTrigger(trigger)) return false;

      trigger.focus({ preventScroll: true });
      setOpen(true);
      return true;
    },
  }));

  return (
    <SelectFocusContext value={focusContext}>
      <SelectPrimitive.Root
        data-slot="select"
        open={open}
        onOpenChange={setOpen}
        disabled={disabled}
        {...rootProps}
      />
    </SelectFocusContext>
  );
}

function SelectGroup({
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Group>) {
  return <SelectPrimitive.Group data-slot="select-group" {...props} />;
}

function SelectValue({
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Value>) {
  return <SelectPrimitive.Value data-slot="select-value" {...props} />;
}

function SelectTrigger({
  className,
  size = 'default',
  children,
  ref,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Trigger> & {
  size?: 'sm' | 'default';
}) {
  const focusContext = React.useContext(SelectFocusContext);

  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      data-size={size}
      className={cn(
        'border-input bg-card hover:text-accent-foreground!',
        'data-placeholder:text-muted-foreground',
        "[&_svg:not([class*='text-'])]:text-muted-foreground hover:[&_svg:not([class*='text-'])]:text-accent-foreground hover:border-accent-foreground",
        "focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive flex w-fit items-center justify-between gap-2 border px-3 py-2 text-sm whitespace-nowrap outline-none focus-visible:ring-[3px] data-[size=default]:h-9 data-[size=sm]:h-8 *:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-2 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        'disabled:cursor-not-allowed disabled:opacity-50 hover:disabled:text-muted-foreground!',
        'rounded-lg cursor-pointer',
        className,
      )}
      ref={(trigger) => {
        if (focusContext) focusContext.triggerRef.current = trigger;
        setRef(ref, trigger);
      }}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronsUpDown className="size-4 opacity-50" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

function SelectContent({
  className,
  children,
  onCloseAutoFocus,
  position = 'popper',
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Content>) {
  const focusContext = React.useContext(SelectFocusContext);

  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        data-slot="select-content"
        className={cn(
          'bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 relative z-popover max-h-(--radix-select-content-available-height) min-w-[8rem] origin-(--radix-select-content-transform-origin) overflow-x-hidden overflow-y-auto scroll-thin rounded-lg border',
          position === 'popper' &&
            'data-[side=bottom]:translate-y-1 data-[side=left]:-translate-x-1 data-[side=right]:translate-x-1 data-[side=top]:-translate-y-1',
          className,
        )}
        position={position}
        onCloseAutoFocus={(event) => {
          onCloseAutoFocus?.(event);

          const selectionCommitted = focusContext?.takeSelection() ?? false;
          if (event.defaultPrevented || !selectionCommitted) return;

          const target = focusContext?.handoffTargetOnSelect?.current;
          if (!target) return;

          if ('focusAndOpen' in target) {
            if (!target.focusAndOpen()) return;
          } else {
            if (!isVisibleEditableTextField(target)) return;
            target.focus({ preventScroll: true });
          }

          event.preventDefault();
        }}
        {...props}
      >
        <SelectScrollUpButton />
        <SelectPrimitive.Viewport
          className={cn(
            'p-1',
            position === 'popper' &&
              'h-[var(--radix-select-trigger-height)] w-full min-w-[var(--radix-select-trigger-width)] scroll-my-1',
          )}
        >
          {children}
        </SelectPrimitive.Viewport>
        <SelectScrollDownButton />
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

function SelectLabel({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Label>) {
  return (
    <SelectPrimitive.Label
      data-slot="select-label"
      className={cn(
        'px-2 py-1.5 text-xs font-semibold cursor-default mt-2 text-muted-foreground',
        className,
      )}
      {...props}
    />
  );
}

function SelectItem({
  className,
  children,
  disabled,
  onClick,
  onKeyDown,
  onPointerUp,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Item>) {
  const focusContext = React.useContext(SelectFocusContext);
  const markSelection = (
    event:
      | React.MouseEvent<HTMLDivElement>
      | React.PointerEvent<HTMLDivElement>
      | React.KeyboardEvent<HTMLDivElement>,
  ) => {
    if (
      !focusContext?.handoffTargetOnSelect ||
      disabled ||
      event.defaultPrevented
    ) {
      return;
    }

    const item = event.currentTarget;
    focusContext.markSelection();
    requestAnimationFrame(() => {
      if (item.isConnected) focusContext.clearSelection();
    });
  };

  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        "focus:bg-accent-foreground focus:text-black focus:[&_svg]:text-black! data-[highlighted]:[&_svg]:text-black! [&_svg:not([class*='text-'])]:text-muted-foreground relative flex w-full cursor-default items-center gap-1 rounded-lg py-1.5 pr-8 pl-2 text-base md:text-sm outline-hidden select-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 *:[span]:last:flex *:[span]:last:items-center *:[span]:last:gap-2",
        'data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
        'cursor-pointer active:opacity-80',
        'group overflow-visible',
        'first:rounded-t-lg last:rounded-b-lg',
        'transition-colors duration-50',
        className,
      )}
      disabled={disabled}
      onClick={(event) => {
        onClick?.(event);
        markSelection(event);
      }}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.key === 'Enter' || event.key === ' ') markSelection(event);
      }}
      onPointerUp={(event) => {
        onPointerUp?.(event);
        markSelection(event);
      }}
      {...props}
    >
      <span className="absolute right-2 flex size-3.5 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <CheckIcon className="size-4" />
        </SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  );
}

function SelectSeparator({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Separator>) {
  return (
    <SelectPrimitive.Separator
      data-slot="select-separator"
      className={cn('bg-border pointer-events-none -mx-1 my-1 h-px', className)}
      {...props}
    />
  );
}

function SelectScrollUpButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollUpButton>) {
  return (
    <SelectPrimitive.ScrollUpButton
      data-slot="select-scroll-up-button"
      className={cn(
        'flex cursor-default items-center justify-center py-1',
        className,
      )}
      {...props}
    >
      <ChevronUpIcon className="size-4" />
    </SelectPrimitive.ScrollUpButton>
  );
}

function SelectScrollDownButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollDownButton>) {
  return (
    <SelectPrimitive.ScrollDownButton
      data-slot="select-scroll-down-button"
      className={cn(
        'flex cursor-default items-center justify-center py-1',
        className,
      )}
      {...props}
    >
      <ChevronDownIcon className="size-4" />
    </SelectPrimitive.ScrollDownButton>
  );
}

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
};
