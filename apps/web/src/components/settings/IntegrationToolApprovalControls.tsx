'use client';

import { useState, type ReactNode } from 'react';

import type { IntegrationToolPolicyMode } from '@roomote/types';

import { cn } from '@/lib/utils';
import {
  Badge,
  Ban,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  Hand,
  MoreHorizontal,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  type LucideIcon,
} from '@/components/system';

const APPROVAL_MODES: {
  mode: IntegrationToolPolicyMode;
  label: string;
  icon: LucideIcon;
}[] = [
  { mode: 'allow', label: 'Always allow', icon: CircleCheck },
  { mode: 'ask', label: 'Ask first', icon: Hand },
  { mode: 'reject', label: 'Reject', icon: Ban },
];

export const INTEGRATION_TOOL_APPROVAL_SAVE_HINT =
  'Approval changes save immediately and apply from the next session turn.';

/**
 * Experiment-gated (`integrationToolApprovals`) per-tool approval mode: one
 * click per tool, with the current mode visible without opening anything.
 * Shared by every integration tool management dialog so built-in and custom
 * MCP integrations offer the same choices.
 */
export function IntegrationToolApprovalModeControl({
  toolName,
  value,
  disabled,
  onChange,
}: {
  toolName: string;
  value: IntegrationToolPolicyMode;
  disabled?: boolean;
  onChange: (mode: IntegrationToolPolicyMode) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={`Approval mode for ${toolName}`}
      className="flex shrink-0 items-center gap-0.5 rounded-md bg-muted/50 p-0.5"
    >
      {APPROVAL_MODES.map(({ mode, label, icon: Icon }) => {
        const checked = mode === value;
        return (
          <button
            key={mode}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={label}
            title={label}
            disabled={disabled}
            onClick={() => {
              if (!checked) onChange(mode);
            }}
            className={cn(
              'flex size-7 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring disabled:cursor-default disabled:opacity-60',
              checked && 'bg-background text-foreground shadow-sm',
            )}
          >
            <Icon aria-hidden="true" className="size-4" />
          </button>
        );
      })}
    </div>
  );
}

type GroupableTool = { name: string; readOnly?: boolean | null };

/**
 * Split tools the way the MCP server describes them: read-only tools apart
 * from ones that can write. A server that annotates none of its tools gets a
 * single untitled group, since calling every tool "write" there would be a
 * guess and a lone "Tools" heading classifies nothing. An
 * unannotated tool on an annotating server counts as able to write, which is
 * the MCP default for a missing `readOnlyHint`.
 */
export function groupIntegrationToolsByAccess<T extends GroupableTool>(
  tools: T[],
): { id: string; title: string | null; tools: T[] }[] {
  if (!tools.some((tool) => typeof tool.readOnly === 'boolean')) {
    return tools.length > 0 ? [{ id: 'all', title: null, tools }] : [];
  }
  return [
    {
      id: 'read-only',
      title: 'Read-only tools',
      tools: tools.filter((tool) => tool.readOnly === true),
    },
    {
      id: 'write',
      title: 'Write/delete tools',
      tools: tools.filter((tool) => tool.readOnly !== true),
    },
  ].filter((group) => group.tools.length > 0);
}

/**
 * One tool group. A titled group collapses; an untitled one (unclassified
 * tools) is just the list. With approvals active the header carries a mode
 * select that applies to every tool in the group; it shows the shared mode,
 * or "Custom" when the group's tools differ.
 */
export function IntegrationToolApprovalGroup({
  title,
  count,
  modes,
  disabled,
  onChangeAll,
  children,
}: {
  /** Null for unclassified tools: no heading and nothing to collapse. */
  title: string | null;
  count: number;
  /** The group's per-tool modes, or undefined while approvals are inactive. */
  modes?: IntegrationToolPolicyMode[];
  disabled?: boolean;
  onChangeAll?: (mode: IntegrationToolPolicyMode) => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  const sharedMode =
    modes && modes.length > 0 && modes.every((mode) => mode === modes[0])
      ? modes[0]
      : undefined;
  const Chevron = open ? ChevronDown : ChevronRight;

  const bulkSelect =
    modes && onChangeAll ? (
      <Select
        value={sharedMode ?? ''}
        disabled={disabled}
        onValueChange={(next) => onChangeAll(next as IntegrationToolPolicyMode)}
      >
        <SelectTrigger
          className="w-44 shrink-0"
          aria-label={`Approval mode for all ${title?.toLowerCase() ?? 'tools'}`}
        >
          <SelectValue
            placeholder={
              <span className="flex items-center gap-2">
                <MoreHorizontal aria-hidden="true" className="size-4" />
                Custom
              </span>
            }
          />
        </SelectTrigger>
        <SelectContent>
          {APPROVAL_MODES.map(({ mode, label, icon: Icon }) => (
            <SelectItem key={mode} value={mode}>
              <Icon aria-hidden="true" className="size-4" />
              {label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    ) : null;

  if (title === null) {
    return (
      <section aria-label="Tools">
        {bulkSelect ? (
          <div className="flex items-center justify-between gap-3 border-b border-border pb-2">
            <span className="text-sm font-medium">
              All tools{' '}
              <Badge variant="secondary" className="ml-1">
                {count}
              </Badge>
            </span>
            {bulkSelect}
          </div>
        ) : null}
        <div className="divide-y divide-border">{children}</div>
      </section>
    );
  }

  return (
    <section aria-label={title}>
      <div className="flex items-center gap-2 py-2">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-sm font-medium"
        >
          <Chevron aria-hidden="true" className="size-4 shrink-0" />
          <span className="truncate">{title}</span>
          <Badge variant="secondary">{count}</Badge>
        </button>
        {bulkSelect}
      </div>
      {open ? <div className="divide-y divide-border">{children}</div> : null}
    </section>
  );
}
