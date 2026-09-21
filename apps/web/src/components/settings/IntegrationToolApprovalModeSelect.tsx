'use client';

import type { IntegrationToolPolicyMode } from '@roomote/types';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/system';

const APPROVAL_MODE_LABELS: Record<IntegrationToolPolicyMode, string> = {
  allow: 'Always allow (default)',
  ask: 'Ask first',
  reject: 'Reject',
};

export const INTEGRATION_TOOL_APPROVAL_SAVE_HINT =
  'Approval changes save immediately and apply from the next session turn.';

/**
 * Experiment-gated (`integrationToolApprovals`) per-tool approval mode
 * control, shared by every integration tool management dialog so built-in
 * and custom MCP integrations offer the same choices.
 */
export function IntegrationToolApprovalModeSelect({
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
    <Select
      value={value}
      disabled={disabled}
      onValueChange={(next) => onChange(next as IntegrationToolPolicyMode)}
    >
      <SelectTrigger
        className="w-56 shrink-0"
        aria-label={`Approval mode for ${toolName}`}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {(
          Object.entries(APPROVAL_MODE_LABELS) as [
            IntegrationToolPolicyMode,
            string,
          ][]
        ).map(([mode, label]) => (
          <SelectItem key={mode} value={mode}>
            {label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
