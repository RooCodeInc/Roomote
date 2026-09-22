'use client';

import { useState, type ReactNode } from 'react';

import {
  integrationToolPolicyKey,
  type IntegrationToolPolicyMode,
} from '@roomote/types';

import { useIntegrationToolApprovalsExperiment } from '@/hooks/useIntegrationToolApprovalsExperiment';
import { useIntegrationToolPolicies } from '@/hooks/useIntegrationToolPolicies';

import { cn } from '@/lib/utils';
import {
  Badge,
  Ban,
  Checkbox,
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
  Sparkles,
  type LucideIcon,
} from '@/components/system';

/**
 * The stored choices a tool can be given. Auto, the default, is no choice at
 * all: a row shows it as nothing selected, and clicking the selected choice
 * again returns to it. The bulk select names it, so a whole group can be
 * returned to Auto in one step.
 */
const STORED_MODES: {
  mode: IntegrationToolPolicyMode;
  label: string;
  icon: LucideIcon;
}[] = [
  { mode: 'always_allow', label: 'Always allow', icon: CircleCheck },
  { mode: 'ask', label: 'Ask first', icon: Hand },
  { mode: 'reject', label: 'Reject', icon: Ban },
];
const BULK_MODES = [
  { mode: 'allow' as const, label: 'Auto', icon: Sparkles },
  ...STORED_MODES,
];

const INTEGRATION_TOOL_APPROVAL_SAVE_HINT =
  'Approval changes save immediately and apply from the next session turn.';

/**
 * Experiment-gated (`integrationToolApprovals`) per-tool approval mode: one
 * click per tool, with the current mode visible without opening anything.
 * Shared by every integration tool management dialog so built-in and custom
 * MCP integrations offer the same choices.
 */
function IntegrationToolApprovalModeControl({
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
      {STORED_MODES.map(({ mode, label, icon: Icon }) => {
        const checked = mode === value;
        return (
          <button
            key={mode}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={label}
            title={checked ? `${label} (click again for Auto)` : label}
            disabled={disabled}
            onClick={() => onChange(checked ? 'allow' : mode)}
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
function groupIntegrationToolsByAccess<T extends GroupableTool>(
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
function IntegrationToolApprovalGroup({
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
          {BULK_MODES.map(({ mode, label, icon: Icon }) => (
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

/**
 * The grouped tool list every integration tool dialog renders, with the
 * experiment-gated approval controls wired in one place. The dialog supplies
 * each tool's own row content (its enable toggle, label, description); this
 * adds the per-tool mode control, the group-level control, and the save hint,
 * or nothing but the grouping when approvals are not active for the viewer.
 */
export function IntegrationToolApprovalList<T extends ManageableTool>({
  integrationId,
  integrationName,
  scope,
  canManage,
  open,
  tools,
  saveNote,
  isToolEnabled,
  onToggleTool,
  toggleDisabled,
}: {
  /** The id policies are keyed on: the mount name agents see. */
  integrationId: string | null;
  /** Dropped from tool names that repeat it ("resend_list_domains"). */
  integrationName: string | null;
  /** `personal` policies apply to the viewer's own sessions only. */
  scope: 'deployment' | 'personal';
  /** Deployment policies are admin-managed; never load them otherwise. */
  canManage: boolean;
  open: boolean;
  tools: T[];
  /** How the dialog's own enable/disable changes are saved. */
  saveNote: string;
  isToolEnabled: (toolName: string) => boolean;
  /** Staged by the dialog until its Save, hence a checkbox, not a switch. */
  onToggleTool: (toolName: string, enabled: boolean) => void;
  toggleDisabled?: boolean;
}) {
  const experiment = useIntegrationToolApprovalsExperiment();
  const active = experiment.enabled && canManage && integrationId != null;
  const policies = useIntegrationToolPolicies({
    enabled: open && active,
    scope,
  });
  const modeFor = (toolName: string) =>
    (integrationId
      ? policies.modes.get(integrationToolPolicyKey(integrationId, toolName))
      : undefined) ?? 'allow';

  return (
    <>
      {active ? (
        <p className="text-xs text-muted-foreground">
          {INTEGRATION_TOOL_APPROVAL_SAVE_HINT}
          {scope === 'personal'
            ? ' These apply to your own sessions only.'
            : ''}{' '}
          {saveNote}
        </p>
      ) : null}
      {groupIntegrationToolsByAccess(tools).map((group) => (
        <IntegrationToolApprovalGroup
          key={group.id}
          title={group.title}
          count={group.tools.length}
          disabled={policies.isUpdating}
          {...(active
            ? {
                modes: group.tools.map((tool) => modeFor(tool.name)),
                onChangeAll: (mode: IntegrationToolPolicyMode) =>
                  policies.setModes(
                    integrationId,
                    group.tools.map((tool) => tool.name),
                    mode,
                  ),
              }
            : {})}
        >
          {group.tools.map((tool) => {
            const checkboxId = `integration-tool-${integrationId ?? 'unknown'}-${tool.name}`;
            return (
              <div key={tool.name} className="flex items-start gap-3 py-2.5">
                <Checkbox
                  id={checkboxId}
                  checked={isToolEnabled(tool.name)}
                  disabled={toggleDisabled}
                  onCheckedChange={(checked) =>
                    onToggleTool(tool.name, checked === true)
                  }
                  className="mt-0.5"
                />
                <div className="min-w-0 flex-1 text-sm">
                  <label
                    htmlFor={checkboxId}
                    title={tool.name}
                    className="cursor-pointer"
                  >
                    {prettifyToolName(tool.name, integrationName)}
                  </label>
                  {tool.description ? (
                    <ToolDescription text={tool.description} />
                  ) : null}
                </div>
                {active ? (
                  <IntegrationToolApprovalModeControl
                    toolName={tool.name}
                    value={modeFor(tool.name)}
                    disabled={policies.isUpdating}
                    onChange={(mode) =>
                      policies.setMode(integrationId, tool.name, mode)
                    }
                  />
                ) : null}
              </div>
            );
          })}
        </IntegrationToolApprovalGroup>
      ))}
    </>
  );
}

type ManageableTool = GroupableTool & { description?: string | null };

function splitToolNameParts(name: string): string[] {
  return name.split(/[-_\s]+/).filter((part) => part.length > 0);
}

/** "resend_list_api_keys" under Resend reads as "List Api Keys". */
function prettifyToolName(
  name: string,
  integrationName: string | null,
): string {
  const nameParts = splitToolNameParts(name);
  const integrationParts = integrationName
    ? splitToolNameParts(integrationName)
    : [];
  const hasIntegrationPrefix =
    integrationParts.length > 0 &&
    integrationParts.every(
      (part, index) => nameParts[index]?.toLowerCase() === part.toLowerCase(),
    );
  const displayParts = hasIntegrationPrefix
    ? nameParts.slice(integrationParts.length)
    : nameParts;

  return (displayParts.length > 0 ? displayParts : nameParts)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}

/**
 * MCP tool descriptions are written for the model and can run to several
 * paragraphs, so long ones clamp to two lines behind a toggle.
 */
function ToolDescription({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const isLong = text.length > 140;

  return (
    <div className="text-xs text-muted-foreground">
      <p className={isLong && !expanded ? 'line-clamp-2' : undefined}>{text}</p>
      {isLong ? (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
          className="mt-0.5 cursor-pointer font-medium text-foreground/80 hover:text-foreground"
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      ) : null}
    </div>
  );
}
