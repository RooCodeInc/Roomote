'use client';

import { useState } from 'react';

import { cn } from '@/lib/utils';
import { useSessionAutoToolApprovals } from '@/hooks/useSessionAutoToolApprovals';

import {
  BasicTooltip,
  Button,
  buttonVariants,
  Check,
  ChevronDown,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Scale,
} from '@/components/system';

type ToolApprovalsMode = 'run' | 'auto';

const MODES: {
  mode: ToolApprovalsMode;
  label: string;
  description: string;
}[] = [
  {
    mode: 'run',
    label: 'Run',
    description:
      'Tools run without a check, unless set to Always ask or Disable.',
  },
  {
    mode: 'auto',
    label: 'Auto',
    description: 'Roomote checks each tool call and asks before risky ones.',
  },
];

const COPY = {
  title: 'Tool approvals',
  tooltip: 'Tool approvals for this session',
  unavailable: 'Not available yet.',
  pausedLabel: 'Auto paused',
  paused: 'Auto couldn’t check tool calls, so tools will ask before running.',
  resume: 'Resume Auto',
};

/**
 * The composer's tool approvals chip: what happens, in this session, to the
 * tools nobody has made a choice about. It opens a short list of modes. The
 * mode is the session owner's choice and every session starts in Run.
 */
export function ToolApprovalsPicker({
  mode,
  available = true,
  paused = false,
  disabled,
  size = 'compact',
  onModeChange,
  onResume,
}: {
  mode: ToolApprovalsMode;
  /** Whether Auto can be chosen; leaving it always works. */
  available?: boolean;
  /** Auto stopped because calls could not be checked. */
  paused?: boolean;
  disabled?: boolean;
  size?: 'compact' | 'base';
  onModeChange: (mode: ToolApprovalsMode) => void;
  onResume?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const autoPaused = mode === 'auto' && paused;
  const label = autoPaused
    ? COPY.pausedLabel
    : MODES.find((entry) => entry.mode === mode)!.label;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <BasicTooltip content={size === 'compact' ? COPY.tooltip : undefined}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={`${COPY.tooltip}: ${label}`}
            disabled={disabled}
            className={cn(
              buttonVariants({ variant: 'ghost', size: 'sm' }),
              'text-muted-foreground hover:bg-secondary gap-1 font-normal',
              size === 'compact' ? 'h-8 px-1! text-xs' : 'h-10 px-2! text-base',
              autoPaused && 'text-amber-600 hover:text-amber-600',
            )}
          >
            {mode === 'auto' ? (
              <Scale
                aria-hidden="true"
                className={size === 'compact' ? 'size-3.5' : 'size-4'}
              />
            ) : null}
            <span>{label}</span>
            <ChevronDown className="size-3 shrink-0" />
          </button>
        </PopoverTrigger>
      </BasicTooltip>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={10}
        className="w-[20rem] rounded-2xl border p-1.5"
      >
        <p className="px-2.5 pt-1.5 pb-1 text-xs font-medium text-muted-foreground">
          {COPY.title}
        </p>
        <div role="listbox" aria-label={COPY.title} className="flex flex-col">
          {MODES.map((entry) => {
            const selected = entry.mode === mode;
            const locked = entry.mode === 'auto' && !available && !selected;
            return (
              <button
                key={entry.mode}
                type="button"
                role="option"
                aria-selected={selected}
                disabled={locked}
                onClick={() => {
                  if (!selected) onModeChange(entry.mode);
                  setOpen(false);
                }}
                className="flex cursor-pointer items-start gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent"
              >
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                    {entry.mode === 'auto' ? (
                      <Scale aria-hidden="true" className="size-3.5" />
                    ) : null}
                    {entry.label}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {entry.description}
                    {locked ? ` ${COPY.unavailable}` : null}
                  </span>
                </span>
                <Check
                  aria-hidden="true"
                  className={cn(
                    'mt-0.5 size-4 shrink-0 text-foreground',
                    !selected && 'invisible',
                  )}
                />
              </button>
            );
          })}
        </div>
        {autoPaused ? (
          <div className="mt-1 flex flex-col items-start gap-2 border-t px-2.5 pt-2.5 pb-1.5">
            <p className="text-xs text-amber-600">{COPY.paused}</p>
            {available && onResume ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  onResume();
                  setOpen(false);
                }}
              >
                {COPY.resume}
              </Button>
            ) : null}
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

/** The tool approvals chip for one running session, shown to its owner. */
export function SessionToolApprovalsPicker({
  sessionId,
  disabled,
}: {
  /** The unified session, which approvals are keyed on. */
  sessionId: string;
  disabled?: boolean;
}) {
  const { state, isSaving, setEnabled } =
    useSessionAutoToolApprovals(sessionId);
  if (!state) return null;

  return (
    <ToolApprovalsPicker
      mode={state.enabled ? 'auto' : 'run'}
      available={state.available}
      paused={state.suspended}
      disabled={disabled || isSaving}
      onModeChange={(mode) => setEnabled(mode === 'auto')}
      onResume={() => setEnabled(true)}
    />
  );
}
