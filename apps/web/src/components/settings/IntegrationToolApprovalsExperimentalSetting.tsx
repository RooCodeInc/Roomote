'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import {
  ChevronDown,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  ShieldQuestion,
  Spinner,
  Switch,
  Textarea,
} from '@/components/system';
import type {
  IntegrationToolPolicyMetadata,
  IntegrationToolPolicyMode,
} from '@roomote/types';
import {
  DEFAULT_INTEGRATION_TOOL_AUTO_APPROVAL_INSTRUCTION,
  integrationToolPolicyKey,
} from '@roomote/types';
import { useCodeModeIntegrationsExperiment } from '@/hooks/useCodeModeIntegrationsExperiment';
import { useIntegrationToolApprovalsExperiment } from '@/hooks/useIntegrationToolApprovalsExperiment';
import { useEffectiveMcpIntegrations } from '@/hooks/mcp-connections/useEffectiveMcpIntegrations';
import { useMcpConnectionTools } from '@/hooks/mcp-connections/useMcpConnectionTools';
import { useTRPC } from '@/trpc/client';

import { Section } from './Section';

const MODE_LABELS: Record<IntegrationToolPolicyMode, string> = {
  allow: 'Always allow (default)',
  ask: 'Ask every time',
  reject: 'Always reject',
  auto: 'Auto (shadow preview — still asks you)',
};

function IntegrationToolPolicyList({
  integrationId,
  integrationName,
  policies,
  onSetMode,
  onSetInstruction,
  isUpdating,
}: {
  integrationId: string;
  integrationName: string;
  policies: Map<string, IntegrationToolPolicyMetadata>;
  onSetMode: (toolName: string, mode: IntegrationToolPolicyMode) => void;
  onSetInstruction: (toolName: string, instruction: string) => void;
  isUpdating: boolean;
}) {
  const tools = useMcpConnectionTools(integrationId);
  if (tools.isLoading) {
    return (
      <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
        <Spinner className="size-4" /> Loading tools…
      </div>
    );
  }
  if (tools.isError || !tools.data) {
    return (
      <p className="py-2 text-sm text-muted-foreground">
        Tools for {integrationName} are unavailable right now.
      </p>
    );
  }
  const enabledTools = tools.data.tools.filter((tool) => tool.enabled);
  if (enabledTools.length === 0) {
    return (
      <p className="py-2 text-sm text-muted-foreground">
        No enabled tools on {integrationName}.
      </p>
    );
  }
  return (
    <ul className="divide-y divide-border">
      {enabledTools.map((tool) => {
        const policy = policies.get(
          integrationToolPolicyKey(integrationId, tool.name),
        );
        const mode = policy?.mode ?? 'allow';
        return (
          <li key={tool.name} className="py-2">
            <div className="flex items-center justify-between gap-3">
              <span className="min-w-0 truncate font-mono text-xs">
                {tool.name}
              </span>
              <Select
                value={mode}
                disabled={isUpdating}
                onValueChange={(value) =>
                  onSetMode(tool.name, value as IntegrationToolPolicyMode)
                }
              >
                <SelectTrigger
                  className="w-64 shrink-0"
                  aria-label={`Approval mode for ${tool.name}`}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(
                    Object.entries(MODE_LABELS) as [
                      IntegrationToolPolicyMode,
                      string,
                    ][]
                  ).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {mode === 'auto' ? (
              <div className="mt-2 space-y-1">
                <p className="text-xs text-muted-foreground">
                  Shadow preview: the judgment model records what it would have
                  recommended for each call, but you still approve every call
                  yourself. Its redacted view of the arguments and a short
                  excerpt of your request leave this deployment to the
                  configured judgment provider.
                </p>
                <Textarea
                  aria-label={`Approval instruction for ${tool.name}`}
                  rows={2}
                  disabled={isUpdating}
                  defaultValue={
                    policy?.instruction ??
                    DEFAULT_INTEGRATION_TOOL_AUTO_APPROVAL_INSTRUCTION
                  }
                  onBlur={(event) =>
                    onSetInstruction(tool.name, event.target.value)
                  }
                />
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Experiment-gated (`integrationToolApprovals`) settings: the admin switch
 * plus the deployment-wide per-tool approval modes. Modes apply to every
 * Session on this deployment while both this experiment and Code Mode
 * Integrations are enabled; tools left at the default run exactly as before.
 */
export function IntegrationToolApprovalsExperimentalSetting() {
  const { enabled, isLoading, isUpdating, setEnabled } =
    useIntegrationToolApprovalsExperiment();
  const codeModeIntegrations = useCodeModeIntegrationsExperiment();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const integrations = useEffectiveMcpIntegrations();
  const policiesQuery = useQuery(
    trpc.integrationToolPolicies.list.queryOptions(),
  );
  const [openIntegrationId, setOpenIntegrationId] = useState<string | null>(
    null,
  );

  const policies = new Map(
    (policiesQuery.data ?? []).map((policy: IntegrationToolPolicyMetadata) => [
      integrationToolPolicyKey(policy.integrationId, policy.toolName),
      policy,
    ]),
  );

  const setPolicy = useMutation(
    trpc.integrationToolPolicies.set.mutationOptions({
      onSuccess: (result) => {
        queryClient.setQueryData(
          trpc.integrationToolPolicies.list.queryKey(),
          result,
        );
      },
      onError: () => {
        toast.error('Failed to update the tool approval policy.');
      },
    }),
  );

  const configurableIntegrations = (integrations.data ?? []).filter(
    (integration) => integration.enabled && integration.available,
  );

  return (
    <Section icon={ShieldQuestion} title="Integration tool approvals">
      <div className="flex gap-3">
        <Switch
          aria-label="Toggle integration tool approvals"
          checked={enabled}
          disabled={isLoading || isUpdating}
          onCheckedChange={setEnabled}
        />
        <p className="text-sm text-muted-foreground">
          Gate individual integration tools behind a requester decision in
          Sessions. Applies on top of Code Mode Integrations: a tool set to Ask
          every time pauses each call until the Session owner allows it once or
          rejects it, and Always reject blocks it outright. Auto is a shadow
          preview: every call still waits for your decision, while the
          configured judgment model records what it would have recommended so
          you can evaluate it before trusting any automation. Tools left at the
          default run exactly as before. Policies apply to every Session on this
          deployment.
        </p>
      </div>
      {enabled && !codeModeIntegrations.enabled ? (
        <p className="mt-3 text-sm text-muted-foreground">
          Code Mode Integrations is off, so these policies currently have no
          effect. Enable both experiments to gate integration tools.
        </p>
      ) : null}
      {enabled ? (
        <div className="mt-4">
          {integrations.isLoading || policiesQuery.isLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner className="size-4" /> Loading integrations…
            </div>
          ) : configurableIntegrations.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No connected integrations to configure.
            </p>
          ) : (
            <ul className="space-y-1">
              {configurableIntegrations.map((integration) => {
                const open = openIntegrationId === integration.id;
                const configuredCount = (policiesQuery.data ?? []).filter(
                  (policy: IntegrationToolPolicyMetadata) =>
                    policy.integrationId === integration.id,
                ).length;
                return (
                  <li key={integration.id} className="rounded-lg border">
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm"
                      aria-expanded={open}
                      onClick={() =>
                        setOpenIntegrationId(open ? null : integration.id)
                      }
                    >
                      <ChevronDown
                        aria-hidden="true"
                        className={`size-4 transition-transform ${open ? '' : '-rotate-90'}`}
                      />
                      <span className="min-w-0 flex-1 truncate font-medium">
                        {integration.name}
                      </span>
                      {configuredCount > 0 ? (
                        <span className="text-xs text-muted-foreground">
                          {configuredCount} configured
                        </span>
                      ) : null}
                    </button>
                    {open ? (
                      <div className="border-t px-3 pb-2">
                        <IntegrationToolPolicyList
                          integrationId={integration.id}
                          integrationName={integration.name}
                          policies={policies}
                          isUpdating={setPolicy.isPending}
                          onSetMode={(toolName, mode) =>
                            setPolicy.mutate({
                              integrationId: integration.id,
                              toolName,
                              mode,
                            })
                          }
                          onSetInstruction={(toolName, instruction) =>
                            setPolicy.mutate({
                              integrationId: integration.id,
                              toolName,
                              mode: 'auto',
                              ...(instruction.trim()
                                ? { instruction: instruction.trim() }
                                : {}),
                            })
                          }
                        />
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
    </Section>
  );
}
