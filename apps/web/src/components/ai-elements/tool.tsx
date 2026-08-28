'use client';

import { type ComponentProps } from 'react';

import type { AcpToolCallPayload, AcpToolResultPayload } from '@roomote/types';

import { cn } from '@/lib/utils';

import {
  type LucideIcon,
  CopyIconButton,
  Collapsible,
  CollapsibleContent,
  CollapsibleIconTrigger,
  CollapsibleTrigger,
} from '@/components/system';

type ToolState =
  | 'input-streaming'
  | 'input-available'
  | 'approval-requested'
  | 'approval-responded'
  | 'output-available'
  | 'output-error'
  | 'output-denied';

const TOOL_STATE_LABELS: Record<ToolState, string> = {
  'input-streaming': 'Running',
  'input-available': 'Running',
  'approval-requested': 'Awaiting approval',
  'approval-responded': 'Responded',
  'output-available': 'Completed',
  'output-error': 'Failed',
  'output-denied': 'Denied',
};

type ToolProps = ComponentProps<typeof Collapsible>;

export const Tool = ({ className, ...props }: ToolProps) => (
  <Collapsible className={cn('group not-prose', className)} {...props} />
);

type ToolHeaderProps = {
  action: string;
  object?: string;
  /** Formatted secondary label rendered after the configured connector. */
  suffix?: string;
  suffixPrefix?: string;
  icon: LucideIcon;
  state: ToolState;
  params?: AcpToolCallPayload | AcpToolResultPayload;
  additions?: number;
  deletions?: number;
  collapsible?: boolean;
  className?: string;
} & Omit<ComponentProps<typeof CollapsibleTrigger>, 'type'>;

export const ToolHeader = ({
  action,
  object,
  suffix,
  suffixPrefix = 'from',
  icon: ActionIcon,
  state,
  params: _params,
  additions,
  deletions,
  collapsible = true,
  className,
  ...props
}: ToolHeaderProps) => {
  const hasDiffStats =
    (additions !== undefined && additions > 0) ||
    (deletions !== undefined && deletions > 0);
  const hasSecondaryLabel = Boolean(object || suffix);
  const statusLabel = TOOL_STATE_LABELS[state];
  const showStatus =
    state === 'input-streaming' ||
    state === 'input-available' ||
    state === 'output-error';

  const inner = (
    <div
      className={cn(
        'flex min-w-0 items-center gap-2 py-1',
        !collapsible && 'cursor-default',
      )}
    >
      {collapsible ? (
        <CollapsibleIconTrigger icon={ActionIcon} />
      ) : (
        <ActionIcon className="size-3 shrink-0" />
      )}

      <span className="flex min-w-0 gap-1 overflow-hidden text-sm whitespace-nowrap">
        {action && (
          <span
            className={cn(
              'font-light',
              hasSecondaryLabel ? 'shrink-0' : 'min-w-0 truncate',
            )}
          >
            {action}
          </span>
        )}
        {object && (
          <span className="min-w-0 truncate font-medium">{object}</span>
        )}
        {suffix && (
          <>
            <span className="shrink-0 font-light">{suffixPrefix}</span>
            <span className="min-w-0 truncate font-medium">{suffix}</span>
          </>
        )}
      </span>

      {hasDiffStats && (
        <span className="flex gap-1.5 text-xs ml-auto shrink-0 tabular-nums mt-0.5">
          {additions !== undefined && additions > 0 && (
            <span className="text-green-700/80">+{additions}</span>
          )}
          {deletions !== undefined && deletions > 0 && (
            <span className="text-red-700/80">-{deletions}</span>
          )}
        </span>
      )}
      <span
        aria-live="polite"
        className={cn(
          showStatus ? 'shrink-0 text-xs' : 'sr-only',
          state === 'output-error' && 'text-destructive',
        )}
      >
        {statusLabel}
      </span>
    </div>
  );

  if (!collapsible) {
    return (
      <div
        className={cn(
          'flex w-full items-center justify-between text-muted-foreground',
          className,
        )}
      >
        {inner}
      </div>
    );
  }

  return (
    <CollapsibleTrigger
      className={cn(
        'flex w-full items-center justify-between cursor-pointer transition-opacity hover:opacity-50 text-muted-foreground',
        className,
      )}
      {...props}
    >
      {inner}
    </CollapsibleTrigger>
  );
};

type ToolContentProps = ComponentProps<typeof CollapsibleContent>;

export const ToolContent = ({ className, ...props }: ToolContentProps) => (
  <CollapsibleContent
    className={cn(
      'data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 text-popover-foreground outline-none data-[state=closed]:animate-out data-[state=open]:animate-in',
      className,
    )}
    {...props}
  />
);

// ---------------------------------------------------------------------------
// ToolInput – recursive key-value display
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatPrimitive(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return value;
  return String(value);
}

function ValueRenderer({ value, depth }: { value: unknown; depth: number }) {
  if (isPlainObject(value)) {
    return <PropertyRows data={value} depth={depth + 1} />;
  }

  if (Array.isArray(value)) {
    return (
      <div className="ml-4 flex flex-col gap-1">
        {value.map((item, i) =>
          isPlainObject(item) ? (
            <PropertyRows key={i} data={item} depth={0} />
          ) : (
            <span
              key={i}
              className="whitespace-pre-wrap font-mono text-muted-foreground"
            >
              {formatPrimitive(item)}
            </span>
          ),
        )}
      </div>
    );
  }

  return <span className="font-mono">{formatPrimitive(value)}</span>;
}

function PropertyRows({
  data,
  depth = 0,
}: {
  data: Record<string, unknown>;
  depth?: number;
}) {
  return (
    <div
      className={cn(
        'flex flex-col text-foreground/70',
        depth === 0 && 'max-h-40 overflow-auto',
        depth > 0 && 'ml-4',
      )}
    >
      {Object.entries(data).map(([key, value]) => {
        const isComplex = isPlainObject(value) || Array.isArray(value);

        return (
          <div
            key={key}
            className="text-[0.8rem] border-b last:border-b-0 border-border/50 leading-tight pt-1.5 pb-1"
          >
            {isComplex ? (
              <>
                <span className="pr-4 font-mono font-bold">{key}:</span>
                <ValueRenderer value={value} depth={depth} />
              </>
            ) : (
              <div className="flex items-start">
                <span className="pr-4 font-mono font-bold">{key}:</span>
                <ValueRenderer value={value} depth={depth} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

type ToolInputProps = ComponentProps<'div'> & {
  input: unknown;
};

export const ToolInput = ({ className, input, ...props }: ToolInputProps) => (
  <div className={cn('space-y-2 overflow-hidden', className)} {...props}>
    <div className="rounded-xl border px-4 py-2 overflow-hidden relative">
      <CopyIconButton
        content={JSON.stringify(input, null, 2) ?? ''}
        tooltip="Copy JSON"
        size="sm"
        className="size-6 shrink-0 animate-[enter-down_100ms_1] absolute right-2 top-1"
        iconClassName="size-3 text-muted-foreground"
      />
      {isPlainObject(input) ? (
        <PropertyRows data={input} />
      ) : (
        <span className="font-mono">{formatPrimitive(input)}</span>
      )}
    </div>
  </div>
);
