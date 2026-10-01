'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { INTEGRATION_TOOL_AUTO_POLICY_MAX_LENGTH } from '@roomote/types';

import { useTRPC } from '@/trpc/client';

import { Button, Label, Textarea } from '@/components/system';

const COPY = {
  description:
    'Roomote can use a judgement model to decide whether a specific action requires approval. Every session starts in Run mode; choose Auto from the tool approvals menu in its message box. You can configure granular approval for each tool in each integration in the ',
  guidanceLabel: 'Additional instructions',
  guidanceHelp:
    'Describe what your deployment considers routine or risky. Optional.',
  guidancePlaceholder:
    'Include any specific guidance for how to decide auto-approval here',
  save: 'Save changes',
  unavailable: 'Auto mode isn’t available yet.',
};

/**
 * Deployment-wide guidance for Auto tool approvals. Rendered on the Agent
 * guidance page, only while the experiment is on. Auto itself is turned on
 * per session, under the composer, by the session's owner.
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

  // The stored mode does not turn Auto on. It is saved back unchanged for
  // N-1 rollback compatibility.
  const mode = settings.data.mode;
  // Auto needs a hosted judgment model; the helper-model fallback would be
  // an LLM call per tool call, so it is never used.
  const available = settings.data.model?.kind === 'judgment';
  const policyDirty = policy.trim() !== settings.data.policy;

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        {COPY.description}
        <Link href="/integrations" className="text-foreground underline">
          Integrations page
        </Link>
        .
      </p>
      <div className="flex flex-col gap-2">
        {!available ? (
          <p className="text-sm text-muted-foreground">{COPY.unavailable}</p>
        ) : null}
        <Label htmlFor="integration-tool-auto-policy">
          {COPY.guidanceLabel}
        </Label>
        <p className="text-sm text-muted-foreground">{COPY.guidanceHelp}</p>
        <Textarea
          id="integration-tool-auto-policy"
          value={policy}
          maxLength={INTEGRATION_TOOL_AUTO_POLICY_MAX_LENGTH}
          placeholder={COPY.guidancePlaceholder}
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
            {COPY.save}
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
