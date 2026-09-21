'use client';

import {
  useEffect,
  forwardRef,
  useRef,
  useState,
  type ComponentProps,
  type KeyboardEvent,
  type ReactNode,
  type UIEvent,
  type WheelEvent,
} from 'react';
import {
  getReasoningEffortLabel,
  REASONING_EFFORT_VALUES,
  type ReasoningEffort,
  type TaskModelMetadata,
} from '@roomote/types';

import {
  BasicTooltip,
  buttonVariants,
  ChevronDown,
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerTitle,
  DrawerTrigger,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Slider,
} from '@/components/system';
import { useIsMobile } from '@/hooks/useIsMobile';
import { cn } from '@/lib/utils';

export type ModelReasoningPickerModel = {
  id: string;
  displayName: string;
  isDefault?: boolean;
  metadata?: TaskModelMetadata | null;
};

const ROW_HEIGHT_PX = 40;
const LIST_HEIGHT_PX = ROW_HEIGHT_PX * 6.5;
const LABEL_HEIGHT_PX = 28;
const SLIDER_TOP_INSET_PX = 8;
const SLIDER_BOTTOM_INSET_PX = 16;
const TYPEAHEAD_IDLE_RESET_MS = 1000;

function supportedEfforts(model: ModelReasoningPickerModel | undefined) {
  if (model?.metadata?.supportsReasoning === false) return [];
  return model?.metadata?.supportedReasoningEfforts ?? REASONING_EFFORT_VALUES;
}

function PickerContent({
  models,
  model,
  defaultModelId,
  emptyModelLabel,
  onModelChange,
  reasoningEffort,
  defaultReasoningEffort,
  onReasoningEffortChange,
  disabled,
  modelDisabled,
  reasoningDisabled,
  supportedReasoningEfforts,
  onClose,
}: {
  models: ModelReasoningPickerModel[];
  model: string;
  defaultModelId?: string | null;
  emptyModelLabel?: string;
  onModelChange: (model: string) => void;
  reasoningEffort: ReasoningEffort | null;
  defaultReasoningEffort?: ReasoningEffort | null;
  onReasoningEffortChange: (effort: ReasoningEffort | null) => void;
  disabled?: boolean;
  modelDisabled?: boolean;
  reasoningDisabled?: boolean;
  supportedReasoningEfforts?: readonly ReasoningEffort[];
  onClose?: () => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const [canScrollUp, setCanScrollUp] = useState(false);
  const [canScrollDown, setCanScrollDown] = useState(false);
  const [typeaheadQuery, setTypeaheadQuery] = useState('');
  const effectiveModelId = model || defaultModelId || '';
  const selectedModel = models.find(({ id }) => id === effectiveModelId);
  const efforts = supportedReasoningEfforts ?? supportedEfforts(selectedModel);
  const requestedEffort = reasoningEffort ?? defaultReasoningEffort;
  const effectiveEffort =
    (requestedEffort && efforts.includes(requestedEffort)
      ? requestedEffort
      : efforts.find((effort) => effort === defaultReasoningEffort)) ??
    efforts[Math.floor((efforts.length - 1) / 2)];
  const effortIndex = effectiveEffort ? efforts.indexOf(effectiveEffort) : 0;

  const options = emptyModelLabel
    ? [{ id: '', displayName: emptyModelLabel }, ...models]
    : models;

  const updateScrollBoundaries = () => {
    const list = listRef.current;
    if (!list) return;
    setCanScrollUp(list.scrollTop > 1);
    setCanScrollDown(
      list.scrollTop + list.clientHeight < list.scrollHeight - 1,
    );
  };

  useEffect(() => {
    updateScrollBoundaries();
    const list = listRef.current;
    if (!list || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(updateScrollBoundaries);
    observer.observe(list);
    return () => observer.disconnect();
  }, [models.length]);

  // Reset the typeahead buffer after a short idle pause so a later keystroke
  // starts a fresh prefix instead of continuing a stale one.
  useEffect(() => {
    if (!typeaheadQuery) return;
    const timer = setTimeout(
      () => setTypeaheadQuery(''),
      TYPEAHEAD_IDLE_RESET_MS,
    );
    return () => clearTimeout(timer);
  }, [typeaheadQuery]);

  const scrollToModelMatch = (query: string) => {
    const list = listRef.current;
    if (!list || !query) return;
    const matchIndex = options.findIndex(({ displayName }) =>
      displayName.toLowerCase().startsWith(query),
    );
    if (matchIndex < 0) return;
    const optionButtons =
      list.querySelectorAll<HTMLButtonElement>('[role="option"]');
    const match = optionButtons[matchIndex];
    if (!match) return;
    match.focus({ preventScroll: true });
    const targetScroll =
      match.offsetTop - (list.clientHeight - match.offsetHeight) / 2;
    list.scrollTop = Math.max(0, targetScroll);
    updateScrollBoundaries();
  };

  // The picker surface has no text field; while it is open, printable
  // keystrokes are captured at the document level and treated as a
  // typeahead prefix that scrolls the model list to the first match.
  // Esc keeps its Radix meaning (close without changing the selection),
  // and Enter closes keeping the current selection, like clicking outside.
  useEffect(() => {
    const handleTypeaheadKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === 'Escape') {
        setTypeaheadQuery('');
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        setTypeaheadQuery('');
        onClose?.();
        return;
      }
      if (event.key === 'Backspace') {
        event.preventDefault();
        const next = typeaheadQuery.slice(0, -1);
        setTypeaheadQuery(next);
        if (next) scrollToModelMatch(next);
        return;
      }
      if (event.key.length !== 1 || event.key === ' ') return;
      event.preventDefault();
      const nextQuery = typeaheadQuery + event.key.toLowerCase();
      setTypeaheadQuery(nextQuery);
      scrollToModelMatch(nextQuery);
    };

    document.addEventListener('keydown', handleTypeaheadKeyDown);
    return () =>
      document.removeEventListener('keydown', handleTypeaheadKeyDown);
  });

  const selectModel = (nextModel: string) => {
    onModelChange(nextModel);
    if (disabled || reasoningDisabled) return;
    // The synthetic default option reports an empty id; resolve it to the
    // effective default model so its supported efforts constrain the change.
    const nextModelId = nextModel || defaultModelId || '';
    const nextModelOption = models.find(({ id }) => id === nextModelId);
    const nextEfforts =
      supportedReasoningEfforts ?? supportedEfforts(nextModelOption);
    if (nextEfforts.length === 0) {
      if (reasoningEffort !== null) onReasoningEffortChange(null);
      return;
    }
    if (reasoningEffort !== null && nextEfforts.includes(reasoningEffort)) {
      return;
    }
    onReasoningEffortChange(
      (defaultReasoningEffort && nextEfforts.includes(defaultReasoningEffort)
        ? defaultReasoningEffort
        : nextEfforts[Math.floor((nextEfforts.length - 1) / 2)])!,
    );
  };

  const moveModelFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const options = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>(
        '[role="option"]',
      ),
    );
    if (options.length === 0) return;
    event.preventDefault();
    const current = options.indexOf(
      document.activeElement as HTMLButtonElement,
    );
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? options.length - 1
          : event.key === 'ArrowDown'
            ? Math.min(options.length - 1, current + 1)
            : Math.max(0, current - 1);
    options[next]?.focus();
  };

  const setEffortIndex = (index: number) => {
    const effort = efforts[index];
    if (effort && effort !== effectiveEffort) onReasoningEffortChange(effort);
  };

  const handleWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (
      disabled ||
      reasoningDisabled ||
      efforts.length < 2 ||
      event.deltaY === 0
    )
      return;
    event.preventDefault();
    setEffortIndex(
      Math.max(
        0,
        Math.min(efforts.length - 1, effortIndex + (event.deltaY < 0 ? 1 : -1)),
      ),
    );
  };

  return (
    <div
      className="grid grid-cols-[minmax(0,1fr)_5.5rem] grid-rows-1 divide-x divide-border overflow-hidden md:grid-cols-[18rem_5.5rem]"
      style={{ height: LIST_HEIGHT_PX }}
    >
      <div className="relative min-w-0">
        <div
          ref={listRef}
          role="listbox"
          aria-label="Models"
          className="scroll-thin h-full overflow-y-auto"
          onKeyDown={moveModelFocus}
          onScroll={(_event: UIEvent<HTMLDivElement>) =>
            updateScrollBoundaries()
          }
        >
          {options.map((option) => {
            const selected = option.id === model;
            return (
              <button
                key={option.id || '__default-model__'}
                type="button"
                role="option"
                aria-selected={selected}
                tabIndex={selected ? 0 : -1}
                disabled={disabled || modelDisabled}
                className={cn(
                  'flex h-10 w-full items-center rounded-md px-3 text-left text-lg transition-colors motion-reduce:transition-none',
                  'hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  selected && 'bg-accent-bright-foreground text-foreground',
                )}
                onClick={() => selectModel(option.id)}
              >
                <span className="min-w-0 flex-1 truncate">
                  {option.displayName}
                  {option.isDefault ? ' (Default)' : ''}
                </span>
              </button>
            );
          })}
        </div>
        <div
          aria-hidden="true"
          data-visible={canScrollUp}
          className="pointer-events-none absolute inset-x-0 top-0 h-6 bg-linear-to-b from-popover to-transparent opacity-0 transition-opacity data-[visible=true]:opacity-100 motion-reduce:transition-none"
        />
        <div
          aria-hidden="true"
          data-visible={canScrollDown}
          className="pointer-events-none absolute inset-x-0 bottom-0 h-6 bg-linear-to-t from-popover to-transparent opacity-0 transition-opacity data-[visible=true]:opacity-100 motion-reduce:transition-none"
        />
      </div>

      <div
        className="flex min-w-0 flex-col items-center gap-0 overflow-hidden px-1"
        onWheel={handleWheel}
      >
        <span
          className="h-7 pt-2 text-center text-sm font-medium"
          aria-live="polite"
        >
          {effectiveEffort
            ? getReasoningEffortLabel(effectiveEffort)
            : 'No reasoning'}
        </span>
        <div className="relative min-h-0 flex-1">
          {efforts.map((effort, index) => (
            <span
              key={effort}
              aria-hidden="true"
              className="pointer-events-none absolute left-1/2 z-10 h-0.5 w-4 -translate-x-1/2 rounded-full bg-background/70"
              style={{
                bottom: `${
                  SLIDER_BOTTOM_INSET_PX +
                  (index / Math.max(1, efforts.length - 1)) *
                    (LIST_HEIGHT_PX -
                      LABEL_HEIGHT_PX -
                      SLIDER_TOP_INSET_PX -
                      SLIDER_BOTTOM_INSET_PX)
                }px`,
              }}
            />
          ))}
          <Slider
            orientation="vertical"
            min={0}
            max={Math.max(0, efforts.length - 1)}
            step={1}
            value={[effortIndex]}
            disabled={disabled || reasoningDisabled || efforts.length < 2}
            aria-label="Reasoning level"
            aria-valuetext={
              effectiveEffort
                ? getReasoningEffortLabel(effectiveEffort)
                : 'No reasoning'
            }
            className="h-full min-h-0 pt-2 pb-4 data-[disabled]:opacity-70 [&_[data-slot=slider-track]]:w-8 [&_[data-slot=slider-track]]:border [&_[data-slot=slider-track]]:border-input [&_[data-slot=slider-track]]:bg-input [&_[data-slot=slider-range]]:bg-accent-foreground [&_[data-slot=slider-thumb]]:size-7 [&_[data-slot=slider-thumb]]:border-2 [&_[data-slot=slider-thumb]]:border-accent-foreground [&_[data-slot=slider-thumb]]:transition-transform motion-reduce:[&_[data-slot=slider-thumb]]:transition-none"
            onValueChange={([index]) => setEffortIndex(index ?? 0)}
          />
        </div>
      </div>
    </div>
  );
}

export function ModelReasoningPicker({
  trigger,
  tooltip,
  open,
  onOpenChange,
  ...contentProps
}: React.ComponentProps<typeof PickerContent> & {
  trigger: ReactNode;
  tooltip?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const isMobile = useIsMobile();

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange} direction="bottom">
        <DrawerTrigger asChild>{trigger}</DrawerTrigger>
        <DrawerContent className="max-h-[80vh]">
          <DrawerTitle className="sr-only">
            Choose model and reasoning
          </DrawerTitle>
          <DrawerDescription className="sr-only">
            Changes apply immediately. Swipe down or tap outside to dismiss.
          </DrawerDescription>
          <PickerContent
            {...contentProps}
            onClose={() => onOpenChange(false)}
          />
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <BasicTooltip content={tooltip}>
        <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      </BasicTooltip>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={6}
        className="relative w-[23.5rem] overflow-visible p-0"
      >
        <PickerContent {...contentProps} onClose={() => onOpenChange(false)} />
        <span
          aria-hidden="true"
          className="absolute -bottom-1 left-5 size-2 rotate-45 border-b border-r border-border bg-popover"
        />
      </PopoverContent>
    </Popover>
  );
}

export const ModelReasoningPickerTrigger = forwardRef<
  HTMLButtonElement,
  Omit<ComponentProps<'button'>, 'children' | 'size'> & {
    label: string;
    reasoningEffort?: ReasoningEffort | null;
    disabled?: boolean;
    size?: 'compact' | 'base';
    ariaLabel: string;
  }
>(function ModelReasoningPickerTrigger(
  {
    label,
    reasoningEffort,
    disabled,
    size = 'compact',
    ariaLabel,
    ...buttonProps
  },
  ref,
) {
  return (
    <button
      ref={ref}
      {...buttonProps}
      data-slot="model-reasoning-picker-trigger"
      type="button"
      aria-label={ariaLabel}
      disabled={disabled}
      className={cn(
        buttonVariants({ variant: 'ghost', size: 'sm' }),
        'text-muted-foreground hover:bg-secondary gap-1 font-normal',
        size === 'compact' ? 'h-8 px-1! text-xs' : 'h-10 px-2! text-base',
      )}
    >
      <span className="max-w-48 truncate">{label}</span>
      {reasoningEffort ? (
        <span className="text-muted-foreground/70">
          {getReasoningEffortLabel(reasoningEffort)}
        </span>
      ) : null}
      <ChevronDown className="size-3 shrink-0" />
    </button>
  );
});
