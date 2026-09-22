'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';

import {
  integrationToolPolicyKey,
  type IntegrationToolSessionOverrideMetadata,
  type IntegrationToolSessionOverrideMode,
  type IntegrationToolSessionOverrideUpsert,
} from '@roomote/types';

import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
  ShieldQuestion,
} from '@/components/system';

type IntegrationToolSessionControlsValue = {
  overrideModes: Map<string, IntegrationToolSessionOverrideMode>;
  setOverride: (input: IntegrationToolSessionOverrideUpsert) => void;
  isUpdating: boolean;
};

const IntegrationToolSessionControlsContext =
  createContext<IntegrationToolSessionControlsValue | null>(null);

/**
 * Experiment-gated (`integrationToolApprovals`) requester controls for the
 * Session transcript. Only the Session owner's transcript mounts this
 * provider; every other transcript (tasks, shared views) has no context, so
 * tool rows render exactly as before.
 */
export function IntegrationToolSessionControlsProvider({
  active,
  overrides,
  setOverride,
  isUpdating,
  children,
}: {
  /** False for non-owners or with the experiment off: rows stay untouched. */
  active: boolean;
  overrides: IntegrationToolSessionOverrideMetadata[];
  setOverride: (input: IntegrationToolSessionOverrideUpsert) => void;
  isUpdating: boolean;
  children: ReactNode;
}) {
  const value = useMemo(
    () => ({
      overrideModes: new Map(
        overrides.map((override) => [
          integrationToolPolicyKey(override.integrationId, override.toolName),
          override.mode,
        ]),
      ),
      setOverride,
      isUpdating,
    }),
    [overrides, setOverride, isUpdating],
  );
  if (!active) return <>{children}</>;
  return (
    <IntegrationToolSessionControlsContext.Provider value={value}>
      {children}
    </IntegrationToolSessionControlsContext.Provider>
  );
}

/**
 * Per-row menu on a settled integration tool call: the requester can ask to
 * be asked about this tool for the rest of the Session, or undo a session
 * choice. It never changes the deployment policy; a tool the deployment
 * rejects never runs, so it never gets a row to put this on.
 */
export function IntegrationToolSessionMenu({
  integrationId,
  toolName,
}: {
  integrationId: string;
  toolName: string;
}) {
  const controls = useContext(IntegrationToolSessionControlsContext);
  if (!controls) return null;

  const mode = controls.overrideModes.get(
    integrationToolPolicyKey(integrationId, toolName),
  );
  const set = (next: IntegrationToolSessionOverrideMode | null) =>
    controls.setOverride({ integrationId, toolName, mode: next });

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-6 shrink-0 text-muted-foreground"
          aria-label={`Approval for ${toolName} in this session`}
          disabled={controls.isUpdating}
        >
          <ShieldQuestion className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          {mode === 'ask'
            ? 'Asking before this tool runs in this session'
            : mode === 'allow'
              ? 'Not asking about this tool in this session'
              : 'Using the default approval for this tool'}
        </DropdownMenuLabel>
        {mode === 'ask' ? (
          <DropdownMenuItem onSelect={() => set(null)}>
            Stop asking this session
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem onSelect={() => set('ask')}>
            Ask me for this tool this session
          </DropdownMenuItem>
        )}
        {mode === 'allow' ? (
          <DropdownMenuItem onSelect={() => set(null)}>
            Reset to the default
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
