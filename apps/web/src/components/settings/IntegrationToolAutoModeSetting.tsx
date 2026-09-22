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
    {
      mode: 'off',
      label: 'Off',
      hint: 'Tools follow their selected mode. Ask first still asks a person.',
    },
    {
      mode: 'on',
      label: 'On',
      hint: 'Roomote runs routine calls for tools set to Auto and asks a person about risky ones.',
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
      onError: () => toast.error('Failed to update automatic approvals.'),
    }),
  );
  if (!settings.data) return null;

  const mode = settings.data.mode;
  const model = settings.data.model;
  const hosted = model?.kind === 'judgment';
  const policyDirty = policy.trim() !== settings.data.policy;
  const modelNote = hosted
    ? mode === 'on'
      ? 'Uses the hosted judgment model.'
      : 'While Off, the hosted judgment model assesses and logs each call for review.'
    : model === null
      ? 'Requires a hosted judgment model. None is available.'
      : `Requires a hosted judgment model. The helper model (${model.model}) makes a full LLM call for every tool call.`;

  return (
    <div className="mt-4 flex flex-col gap-3 border-t pt-4">
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium">Automatic approvals</p>
        <p className="text-sm text-muted-foreground">
          Let a decision model handle tools set to Auto. Your other choices stay
          fixed. {modelNote}
        </p>
      </div>
      <div
        role="radiogroup"
        aria-label="Automatic approvals"
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
              disabled={save.isPending || (option.mode === 'on' && !hosted)}
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
        <Label htmlFor="integration-tool-auto-policy">Approval guidance</Label>
        <Textarea
          id="integration-tool-auto-policy"
          value={policy}
          maxLength={INTEGRATION_TOOL_AUTO_POLICY_MAX_LENGTH}
          placeholder="Describe what’s routine and what’s risky. For example: Reading and searching are routine. Anything sent to customers is risky."
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
            Save guidance
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
