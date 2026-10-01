'use client';

import { useId, type ReactNode } from 'react';

import { cn } from '@/lib/utils';
import { useSessionAutoToolApprovals } from '@/hooks/useSessionAutoToolApprovals';

import { Button, Switch } from '@/components/system';

const COPY = {
  label: 'Auto-approval',
  help: 'Let Roomote decide when something is worth interrupting for approval.',
  unavailable: 'Auto mode isn’t available yet.',
  paused:
    'Paused because calls couldn’t be checked. Tools ask you before running.',
  resume: 'Resume',
};

/**
 * The Auto switch that sits under a message composer. Auto is the session
 * owner's choice for one session and starts off.
 */
export function AutoToolApprovalsSwitch({
  checked,
  available = true,
  disabled,
  onCheckedChange,
  note,
  action,
  className,
}: {
  checked: boolean;
  /** Whether Auto can be turned on; turning it off always works. */
  available?: boolean;
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
  note?: string;
  action?: ReactNode;
  className?: string;
}) {
  const id = useId();
  const locked = !checked && !available;
  return (
    <div
      className={cn(
        'flex items-center gap-2 px-4 py-2 text-xs text-muted-foreground',
        className,
      )}
    >
      <Switch
        id={id}
        checked={checked}
        disabled={disabled || locked}
        onCheckedChange={onCheckedChange}
      />
      <label htmlFor={id} className="shrink-0 font-medium text-foreground">
        {COPY.label}
      </label>
      <span className="min-w-0 truncate">
        {note ?? (locked ? COPY.unavailable : COPY.help)}
      </span>
      {action}
    </div>
  );
}

/** Auto for one running session, shown to its owner under the composer. */
export function SessionAutoToolApprovals({
  sessionId,
  className,
}: {
  /** The unified session, which approvals are keyed on. */
  sessionId: string;
  className?: string;
}) {
  const { state, isSaving, setEnabled } =
    useSessionAutoToolApprovals(sessionId);
  if (!state) return null;

  const paused = state.enabled && state.suspended;
  return (
    <AutoToolApprovalsSwitch
      className={className}
      checked={state.enabled}
      available={state.available}
      disabled={isSaving}
      onCheckedChange={setEnabled}
      {...(paused ? { note: COPY.paused } : {})}
      action={
        paused && state.available ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 shrink-0 px-2 text-xs"
            disabled={isSaving}
            onClick={() => setEnabled(true)}
          >
            {COPY.resume}
          </Button>
        ) : null
      }
    />
  );
}
