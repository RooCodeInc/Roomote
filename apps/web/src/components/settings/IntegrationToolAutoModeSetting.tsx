'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import {
  INTEGRATION_TOOL_AUTO_POLICY_MAX_LENGTH,
  type IntegrationToolAutoMode,
} from '@roomote/types';

import { useTRPC } from '@/trpc/client';

import { Button, Label, Textarea } from '@/components/system';

const MODES: { mode: IntegrationToolAutoMode; label: string; hint: string }[] =
  [
    { mode: 'off', label: 'Off', hint: 'Ask first tools always ask a person.' },
    {
      mode: 'shadow',
      label: 'Shadow',
      hint: 'Ask a person, and record what Roomote would have decided.',
    },
    {
      mode: 'on',
      label: 'On',
      hint: 'Roomote runs a call it finds clearly safe under the policy, and asks a person about everything else.',
    },
  ];

/**
 * Deployment-wide Auto mode for tool approvals: who answers an Ask first
 * call. Rendered inside the experiment section, only while the experiment
 * is on. Reject is never affected, and the model can only ever run a call
 * or ask; it never rejects one.
 */
export function IntegrationToolAutoModeSetting() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const settings = useQuery(
    trpc.integrationToolPolicies.getAuto.queryOptions(),
  );
  const [policy, setPolicy] = useState('');
  useEffect(() => {
    if (settings.data) setPolicy(settings.data.policy);
  }, [settings.data]);

  const save = useMutation(
    trpc.integrationToolPolicies.setAuto.mutationOptions({
      onSuccess: (result) => {
        queryClient.setQueryData(
          trpc.integrationToolPolicies.getAuto.queryKey(),
          result,
        );
      },
      onError: () => toast.error('Failed to update Auto mode.'),
    }),
  );
  if (!settings.data) return null;

  const mode = settings.data.mode;
  const model = settings.data.model;
  const policyDirty = policy.trim() !== settings.data.policy;

  return (
    <div className="mt-4 flex flex-col gap-3 border-t pt-4">
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium">Auto mode</p>
        <p className="text-sm text-muted-foreground">
          Who answers an Ask first call.{' '}
          {model === null
            ? 'No decision model is available, so Auto can only ask.'
            : model.kind === 'judgment'
              ? 'Uses the hosted judgment model.'
              : `No judgment model is configured, so Auto uses the helper model (${model.model}), which costs an inference call per ask.`}
        </p>
      </div>
      <div
        role="radiogroup"
        aria-label="Auto mode"
        className="flex flex-col gap-2 sm:flex-row"
      >
        {MODES.map((option) => {
          const checked = option.mode === mode;
          return (
            <button
              key={option.mode}
              type="button"
              role="radio"
              aria-checked={checked}
              disabled={save.isPending}
              onClick={() => {
                if (!checked) save.mutate({ mode: option.mode, policy });
              }}
              className={`flex flex-1 cursor-pointer flex-col items-start gap-0.5 rounded-md border p-3 text-left text-sm transition-colors hover:bg-muted/50 disabled:cursor-default disabled:opacity-60 ${
                checked ? 'border-foreground/40 bg-muted/50' : 'border-border'
              }`}
            >
              <span className="font-medium">{option.label}</span>
              <span className="text-muted-foreground">{option.hint}</span>
            </button>
          );
        })}
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="integration-tool-auto-policy">Auto policy</Label>
        <Textarea
          id="integration-tool-auto-policy"
          value={policy}
          maxLength={INTEGRATION_TOOL_AUTO_POLICY_MAX_LENGTH}
          placeholder="What may run without a person approving it, and what never may. For example: reading and searching is fine; never send messages or delete anything."
          rows={4}
          onChange={(event) => setPolicy(event.target.value)}
        />
        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            disabled={!policyDirty || save.isPending}
            onClick={() => save.mutate({ mode, policy })}
          >
            Save policy
          </Button>
          {policyDirty ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={save.isPending}
              onClick={() => setPolicy(settings.data.policy)}
            >
              Discard
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
