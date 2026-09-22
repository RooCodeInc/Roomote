'use client';

import {
  useEffect,
  forwardRef,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type KeyboardEvent,
  type ReactNode,
  type UIEvent,
} from 'react';
import {
  AnimatePresence,
  motion,
  useReducedMotion,
  type Variants,
} from 'motion/react';
import { usePathname } from 'next/navigation';
import {
  getReasoningEffortLabel,
  groupModelsByDisplayProvider,
  REASONING_EFFORT_VALUES,
  type ReasoningEffort,
  type TaskModelMetadata,
} from '@roomote/types';

import {
  ArrowDownIcon,
  BasicTooltip,
  Button,
  buttonVariants,
  ChevronDown,
  ChevronsUpDown,
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerTitle,
  DrawerTrigger,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Settings,
  Slider,
} from '@/components/system';
import { useIsMobile } from '@/hooks/useIsMobile';
import { useUser } from '@/hooks/useUser';
import { cn } from '@/lib/utils';

export type ModelReasoningPickerModel = {
  id: string;
  displayName: string;
  isDefault?: boolean;
  metadata?: TaskModelMetadata | null;
  providerLabel?: string;
};

type ProviderGroupingOptions = {
  chatgptConnected?: boolean;
  openaiConnected?: boolean;
  xaiSubscriptionConnected?: boolean;
  xaiConnected?: boolean;
};

const ROW_HEIGHT_PX = 40;
const LIST_HEIGHT_PX = ROW_HEIGHT_PX * 6.5;
const MODEL_OPTION_SCROLL_OFFSET_PX = ROW_HEIGHT_PX / 2;
const SLIDER_THUMB_RADIUS_PX = 14;
const TYPEAHEAD_IDLE_RESET_MS = 1000;
const SELECTION_FLASH_HOLD_MS = 150;
const REASONING_LABEL_OFFSET_PX = 12;
const REASONING_LABEL_DURATION_SECONDS = 0.2;
const REASONING_LABEL_ENTER_DELAY_SECONDS = 0.05;
const REASONING_LABEL_EASING = [0.22, 1, 0.36, 1] as const;
const REASONING_UNAVAILABLE_LABEL = 'N/A';

type ReasoningLabelTransition = {
  direction: 1 | -1;
  reducedMotion: boolean;
};

const reasoningLabelVariants: Variants = {
  enter: ({ direction, reducedMotion }: ReasoningLabelTransition) => ({
    opacity: reducedMotion ? 1 : 0,
    y: reducedMotion ? 0 : direction * REASONING_LABEL_OFFSET_PX,
  }),
  center: ({ reducedMotion }: ReasoningLabelTransition) => ({
    opacity: 1,
    y: 0,
    transition: {
      duration: reducedMotion ? 0 : REASONING_LABEL_DURATION_SECONDS,
      delay: reducedMotion ? 0 : REASONING_LABEL_ENTER_DELAY_SECONDS,
      ease: REASONING_LABEL_EASING,
    },
  }),
  exit: ({ direction, reducedMotion }: ReasoningLabelTransition) => ({
    opacity: reducedMotion ? 1 : 0,
    y: reducedMotion ? 0 : direction * -REASONING_LABEL_OFFSET_PX,
    transition: {
      duration: reducedMotion ? 0 : REASONING_LABEL_DURATION_SECONDS,
      ease: REASONING_LABEL_EASING,
    },
  }),
};

function supportedEfforts(model: ModelReasoningPickerModel | undefined) {
  if (model?.metadata?.supportsReasoning === false) return [];
  return model?.metadata?.supportedReasoningEfforts ?? REASONING_EFFORT_VALUES;
}

function closestSupportedEffort(
  effort: ReasoningEffort,
  supported: readonly ReasoningEffort[],
): ReasoningEffort | undefined {
  const effortIndex = REASONING_EFFORT_VALUES.indexOf(effort);
  return supported.reduce<ReasoningEffort | undefined>((closest, candidate) => {
    if (!closest) return candidate;
    const candidateDistance = Math.abs(
      REASONING_EFFORT_VALUES.indexOf(candidate) - effortIndex,
    );
    const closestDistance = Math.abs(
      REASONING_EFFORT_VALUES.indexOf(closest) - effortIndex,
    );
    return candidateDistance < closestDistance ? candidate : closest;
  }, undefined);
}

function getPickerReasoningEffortLabel(effort: ReasoningEffort): string {
  return effort === 'xhigh' ? 'X-High' : getReasoningEffortLabel(effort);
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
  providerGrouping,
  onModelSelectionChange,
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
  /**
   * Receives the model and reasoning effort together whenever a selection
   * changes either value, so callers tracking the combined state never see
   * a stale intermediate model or effort.
   */
  onModelSelectionChange?: (selection: {
    model: string;
    reasoningEffort: ReasoningEffort | null;
  }) => void;
  disabled?: boolean;
  modelDisabled?: boolean;
  reasoningDisabled?: boolean;
  supportedReasoningEfforts?: readonly ReasoningEffort[];
  providerGrouping?: ProviderGroupingOptions;
  onClose?: () => void;
}) {
  const { user } = useUser();
  const pathname = usePathname();
  const showModelSettings =
    user?.isAdmin === true && pathname !== '/settings/models';
  const listRef = useRef<HTMLDivElement>(null);
  const selectedOptionRef = useRef<HTMLButtonElement>(null);
  const hasScrolledToInitialSelectionRef = useRef(false);
  const reasoningPanelRef = useRef<HTMLDivElement>(null);
  const previousEffortIndexRef = useRef(0);
  const [canScrollUp, setCanScrollUp] = useState(false);
  const [canScrollDown, setCanScrollDown] = useState(false);
  const [typeaheadQuery, setTypeaheadQuery] = useState('');
  const effectiveModelId = model || defaultModelId || '';
  const selectedModel = models.find(({ id }) => id === effectiveModelId);
  const efforts = supportedReasoningEfforts ?? supportedEfforts(selectedModel);
  const reasoningUnavailable = efforts.length === 0;
  const effectiveEffort =
    (reasoningEffort
      ? efforts.includes(reasoningEffort)
        ? reasoningEffort
        : closestSupportedEffort(reasoningEffort, efforts)
      : efforts.find((effort) => effort === defaultReasoningEffort)) ??
    efforts[Math.floor((efforts.length - 1) / 2)];
  const effortIndex = effectiveEffort ? efforts.indexOf(effectiveEffort) : 0;
  const reducedMotion = useReducedMotion() ?? false;
  const effortTransitionDirection: 1 | -1 =
    effortIndex < previousEffortIndexRef.current ? -1 : 1;
  const effortLabel = effectiveEffort
    ? getPickerReasoningEffortLabel(effectiveEffort)
    : REASONING_UNAVAILABLE_LABEL;
  const labelTransition: ReasoningLabelTransition = {
    direction: effortTransitionDirection,
    reducedMotion,
  };

  useEffect(() => {
    previousEffortIndexRef.current = effortIndex;
  }, [effortIndex]);

  useEffect(() => {
    if (
      hasScrolledToInitialSelectionRef.current ||
      !selectedOptionRef.current
    ) {
      return;
    }
    selectedOptionRef.current.scrollIntoView({ block: 'nearest' });
    hasScrolledToInitialSelectionRef.current = true;
  });

  const { leadingOptions, modelGroups, options } = useMemo(() => {
    const selectableModels = emptyModelLabel
      ? [{ id: '', displayName: emptyModelLabel }, ...models]
      : models;
    const leading = selectableModels.filter(({ id }) => !id.includes('/'));
    const groups = groupModelsByDisplayProvider(
      selectableModels.filter(({ id }) => id.includes('/')),
      providerGrouping,
    ).map((group) => ({
      ...group,
      label:
        group.items.find(({ providerLabel }) => providerLabel)?.providerLabel ??
        group.label,
    }));

    return {
      leadingOptions: leading,
      modelGroups: groups,
      options: [...leading, ...groups.flatMap(({ items }) => items)],
    };
  }, [emptyModelLabel, models, providerGrouping]);

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
  }, [modelGroups.length, options.length]);

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

  const applyModelSelection = (
    nextModel: string,
    nextReasoningEffort: ReasoningEffort | null,
  ) => {
    // An atomic combined callback lets callers that track the whole
    // selection (such as the session voice-turn ref) apply the model and
    // effort together instead of observing a stale intermediate state.
    if (onModelSelectionChange) {
      onModelSelectionChange({
        model: nextModel,
        reasoningEffort: nextReasoningEffort,
      });
      return;
    }
    onModelChange(nextModel);
    if (nextReasoningEffort !== reasoningEffort) {
      onReasoningEffortChange(nextReasoningEffort);
    }
  };

  const selectModel = (nextModel: string) => {
    if (disabled || reasoningDisabled) {
      applyModelSelection(nextModel, reasoningEffort);
      return;
    }
    const effectiveNextModelId = nextModel || defaultModelId || '';
    const nextModelOption = models.find(
      ({ id }) => id === effectiveNextModelId,
    );
    const nextEfforts =
      supportedReasoningEfforts ?? supportedEfforts(nextModelOption);
    if (nextEfforts.length === 0) {
      applyModelSelection(nextModel, null);
      return;
    }
    if (reasoningEffort !== null) {
      if (nextEfforts.includes(reasoningEffort)) {
        applyModelSelection(nextModel, reasoningEffort);
        return;
      }
      applyModelSelection(
        nextModel,
        closestSupportedEffort(reasoningEffort, nextEfforts) ?? reasoningEffort,
      );
      return;
    }
    applyModelSelection(
      nextModel,
      (defaultReasoningEffort && nextEfforts.includes(defaultReasoningEffort)
        ? defaultReasoningEffort
        : nextEfforts[Math.floor((nextEfforts.length - 1) / 2)])!,
    );
  };

  const scrollModelOptionIntoView = (option: HTMLButtonElement) => {
    const list = listRef.current;
    if (!list) return;

    const listRect = list.getBoundingClientRect();
    const optionRect = option.getBoundingClientRect();
    const scrollDelta =
      optionRect.top < listRect.top
        ? optionRect.top - listRect.top - MODEL_OPTION_SCROLL_OFFSET_PX
        : optionRect.bottom > listRect.bottom
          ? optionRect.bottom - listRect.bottom + MODEL_OPTION_SCROLL_OFFSET_PX
          : 0;

    if (scrollDelta === 0) return;
    list.scrollTo({
      top: list.scrollTop + scrollDelta,
      behavior: reducedMotion ? 'auto' : 'smooth',
    });
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

  useEffect(() => {
    const reasoningPanel = reasoningPanelRef.current;
    if (!reasoningPanel) return;

    const interceptWheel = (event: globalThis.WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (
        disabled ||
        reasoningDisabled ||
        efforts.length < 2 ||
        event.deltaY === 0
      ) {
        return;
      }

      const nextIndex = Math.max(
        0,
        Math.min(efforts.length - 1, effortIndex + (event.deltaY < 0 ? 1 : -1)),
      );
      const effort = efforts[nextIndex];
      if (effort && effort !== effectiveEffort) {
        onReasoningEffortChange(effort);
      }
    };

    reasoningPanel.addEventListener('wheel', interceptWheel, {
      passive: false,
    });
    return () => reasoningPanel.removeEventListener('wheel', interceptWheel);
  }, [
    disabled,
    effectiveEffort,
    effortIndex,
    efforts,
    onReasoningEffortChange,
    reasoningDisabled,
  ]);

  const renderModelOption = (option: ModelReasoningPickerModel) => {
    const selected = option.id === model;
    return (
      <button
        ref={selected ? selectedOptionRef : undefined}
        key={option.id || '__default-model__'}
        type="button"
        role="option"
        aria-selected={selected}
        tabIndex={selected ? 0 : -1}
        disabled={disabled || modelDisabled}
        className={cn(
          'flex h-10 w-full cursor-pointer items-center rounded-md px-3 text-left text-sm transition-colors motion-reduce:transition-none',
          'hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          selected && '',
        )}
        onClick={(event) => {
          scrollModelOptionIntoView(event.currentTarget);
          selectModel(option.id);
        }}
      >
        <span className="min-w-0 flex-1 truncate flex items-center gap-2">
          <span className="size-4">
            <ArrowDownIcon
              className={`size-4 text-current transition-opacity -rotate-90 ${selected ? 'opacity-100 animate-bounce' : 'opacity-0'}`}
            />
          </span>
          {option.displayName}
          {option.isDefault ? ' (Default)' : ''}
        </span>
      </button>
    );
  };

  return (
    <div
      className="grid grid-cols-[1fr_3.5rem] grid-rows-1 divide-x divide-border overflow-hidden border-t md:border-t-0 mt-4 md:mt-0"
      style={{ height: LIST_HEIGHT_PX }}
    >
      <div className="relative min-w-0 overflow-hidden">
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
          {leadingOptions.map(renderModelOption)}
          {modelGroups.map((group) => (
            <div
              key={group.providerId}
              role="group"
              aria-label={`${group.label} models`}
            >
              <div
                aria-hidden="true"
                className="flex items-center gap-2 pl-9 pr-3 py-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase"
              >
                {group.label}
              </div>
              {group.items.map(renderModelOption)}
            </div>
          ))}
        </div>
        <div
          aria-hidden="true"
          data-visible={canScrollUp}
          className={cn(
            'pointer-events-none absolute inset-x-0 top-0 h-12 bg-linear-to-b from-background md:from-card to-transparent transition-transform motion-reduce:transition-none rounded-tl-2xl',
            canScrollUp ? 'opacity-80' : 'opacity-0',
          )}
        />
        <div
          aria-hidden="true"
          data-visible={canScrollDown}
          className={cn(
            'pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-linear-to-t from-background md:from-card to-transparent transition-transform motion-reduce:transition-none rounded-bl-2xl',
            canScrollDown ? 'opacity-80' : 'opacity-0',
          )}
        />
      </div>

      <div
        ref={reasoningPanelRef}
        className="flex min-w-0 flex-col items-center overflow-hidden pt-1"
      >
        <span
          data-testid="reasoning-level-label"
          data-transition-direction={
            effortTransitionDirection > 0 ? 'up' : 'down'
          }
          className="relative h-7 w-full shrink-0 text-center text-xs font-medium"
        >
          <AnimatePresence initial={false} custom={labelTransition}>
            <motion.span
              key={effectiveEffort ?? 'no-reasoning'}
              aria-hidden="true"
              className="absolute inset-x-0 top-3"
              custom={labelTransition}
              variants={reasoningLabelVariants}
              initial="enter"
              animate="center"
              exit="exit"
            >
              {effortLabel}
            </motion.span>
          </AnimatePresence>
          <span className="sr-only" role="status" aria-label={effortLabel} />
        </span>
        <div className="relative min-h-0 flex-1 pb-4 pt-2">
          <div
            className={cn(
              'relative h-full',
              reasoningUnavailable ? 'cursor-not-allowed' : 'cursor-ns-resize',
            )}
          >
            {efforts.map((effort, index) => {
              const position = index / Math.max(1, efforts.length - 1);
              const endpointOffset =
                SLIDER_THUMB_RADIUS_PX * (1 - position * 2);
              return (
                <span
                  key={effort}
                  aria-hidden="true"
                  className="pointer-events-none absolute left-1/2 z-10 h-0.5 w-2 -translate-x-1/2 translate-y-1/2 rounded-full bg-background/40"
                  style={{
                    bottom: `calc(${position * 100}% + ${endpointOffset}px)`,
                  }}
                />
              );
            })}
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
                  ? getPickerReasoningEffortLabel(effectiveEffort)
                  : REASONING_UNAVAILABLE_LABEL
              }
              className={cn(
                'h-full min-h-0 data-[orientation=vertical]:min-h-0 [&>span:not([data-slot])]:transition-[bottom] [&>span:not([data-slot])]:duration-300 [&>span:not([data-slot])]:ease-out motion-reduce:[&>span:not([data-slot])]:transition-none [&_[data-slot=slider-track]]:w-4 [&_[data-slot=slider-track]]:border [&_[data-slot=slider-track]]:border-input [&_[data-slot=slider-track]]:bg-input [&_[data-slot=slider-thumb]]:size-7 [&_[data-slot=slider-thumb]]:border-2',
                reasoningUnavailable
                  ? '[&_[data-slot=slider-range]]:bg-transparent [&_[data-slot=slider-thumb]]:border-input [&_[data-slot=slider-thumb]]:hover:ring-0'
                  : '[&_[data-slot=slider-range]]:bg-accent-foreground [&_[data-slot=slider-thumb]]:border-accent-foreground',
              )}
              onValueChange={([index]) => setEffortIndex(index ?? 0)}
            />
          </div>
        </div>
        {showModelSettings ? (
          <div className="h-14 w-full shrink-0 pt-2">
            <div className="flex h-full items-center justify-center border-t">
              <BasicTooltip content="Model settings">
                <Button
                  asChild
                  variant="ghost"
                  size="icon"
                  className="shrink-0 text-muted-foreground"
                >
                  <a
                    href="/settings/models"
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label="Open model settings in a new tab"
                  >
                    <Settings />
                  </a>
                </Button>
              </BasicTooltip>
            </div>
          </div>
        ) : null}
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
        sideOffset={10}
        className="relative w-[22rem] overflow-visible p-0 border rounded-2xl"
      >
        <PickerContent {...contentProps} onClose={() => onOpenChange(false)} />
        <svg
          aria-hidden="true"
          viewBox="0 0 16 9"
          fill="none"
          className="pointer-events-none absolute -bottom-[9px] left-5 h-[9px] w-4 overflow-visible"
        >
          <path d="M0 0H16L8 8Z" className="fill-popover" />
          <path
            d="M0 0.5L8 8.5L16 0.5"
            className="stroke-border"
            strokeWidth="1"
            strokeLinejoin="miter"
          />
        </svg>
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
    appearance?: 'ghost' | 'select';
    ariaLabel: string;
  }
>(function ModelReasoningPickerTrigger(
  {
    label,
    reasoningEffort,
    disabled,
    size = 'compact',
    appearance = 'ghost',
    ariaLabel,
    className,
    ...buttonProps
  },
  ref,
) {
  const previousSelectionRef = useRef({ label, reasoningEffort });
  const [selectionFlash, setSelectionFlash] = useState(false);

  useEffect(() => {
    const previousSelection = previousSelectionRef.current;
    previousSelectionRef.current = { label, reasoningEffort };
    if (
      previousSelection.label === label &&
      previousSelection.reasoningEffort === reasoningEffort
    ) {
      return;
    }

    setSelectionFlash(true);
    const timeout = window.setTimeout(
      () => setSelectionFlash(false),
      SELECTION_FLASH_HOLD_MS,
    );
    return () => window.clearTimeout(timeout);
  }, [label, reasoningEffort]);

  return (
    <button
      ref={ref}
      {...buttonProps}
      data-slot="model-reasoning-picker-trigger"
      type="button"
      aria-label={ariaLabel}
      disabled={disabled}
      data-selection-flash={selectionFlash}
      data-appearance={appearance}
      className={cn(
        appearance === 'select'
          ? [
              'border-input bg-card text-foreground hover:border-accent-foreground hover:text-accent-foreground!',
              'focus-visible:border-ring focus-visible:ring-ring/50 flex h-9 w-fit cursor-pointer items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm font-normal whitespace-nowrap outline-none focus-visible:ring-[3px]',
              'disabled:cursor-not-allowed disabled:opacity-50 hover:disabled:text-muted-foreground!',
            ]
          : [
              buttonVariants({ variant: 'ghost', size: 'sm' }),
              'text-muted-foreground hover:bg-secondary gap-1 font-normal',
              size === 'compact' ? 'h-8 px-1! text-xs' : 'h-10 px-2! text-base',
            ],
        'transition-colors duration-500 motion-reduce:transition-none',
        selectionFlash && 'text-accent-foreground duration-0',
        className,
      )}
    >
      <span className="max-w-48 truncate">{label}</span>
      {reasoningEffort ? (
        <span
          className={cn(
            'text-muted-foreground/70 transition-colors duration-500 motion-reduce:transition-none',
            selectionFlash && 'text-accent-foreground duration-0',
          )}
        >
          {getPickerReasoningEffortLabel(reasoningEffort)}
        </span>
      ) : null}
      {appearance === 'select' ? (
        <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
      ) : (
        <ChevronDown className="size-3 shrink-0" />
      )}
    </button>
  );
});
