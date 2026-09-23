'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { INTEGRATION_TOOL_AUTO_POLICY_MAX_LENGTH } from '@roomote/types';

import { useTRPC } from '@/trpc/client';

import { Button, Label, Switch, Textarea } from '@/components/system';

const COPY = {
  description:
    'Roomote can use a judgement model to decide whether a specific action requires approval. You can configure granular approval for each tool in each integration in the ',
  switchHelp:
    'Let Roomote decide when something is worth interrupting for approval.',
  guidanceLabel: 'Additional instructions',
  guidanceHelp:
    'Describe what your deployment considers routine or risky. Optional.',
  guidancePlaceholder:
    'Include any specific guidance for how to decide auto-approval here',
  save: 'Save changes',
  unavailable: 'Auto mode isn’t available yet.',
};

/**
 * Deployment-wide Auto mode for tool approvals. Rendered on the
 * Agent guidance page, only while the experiment is on. Reject is never
 * affected, and Auto only runs routine calls; it asks about anything risky.
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
  // On needs a hosted judgment model; the helper-model fallback would be an
  // LLM call per tool call, so it is never used.
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
      <div className="flex gap-3">
        <Switch
          aria-label="Enable auto-approval"
          checked={mode === 'on'}
          disabled={save.isPending || (mode === 'off' && !available)}
          onCheckedChange={(checked) =>
            save.mutate({ mode: checked ? 'on' : 'off', policy })
          }
        />
        <div className="space-y-1">
          <p className="text-sm font-semibold text-foreground">
            Enable auto-approval
          </p>
          <p className="text-sm text-foreground">{COPY.switchHelp}</p>
        </div>
      </div>
      {mode === 'on' ? (
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
      ) : null}
    </div>
  );
}
