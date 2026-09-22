'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import {
  INTEGRATION_TOOL_AUTO_POLICY_MAX_LENGTH,
  type IntegrationToolAutoMode,
} from '@roomote/types';

import { useTRPC } from '@/trpc/client';

import {
  Button,
  ChevronDown,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Label,
  Textarea,
} from '@/components/system';

/** Customer-facing copy: what Auto mode does for the person, no mechanics. */
const COPY = {
  description:
    'Let Roomote handle routine work and ask before anything risky. Your other tool choices stay the same.',
  off: 'Keep each tool’s current choice.',
  on: 'Handle routine work automatically and ask before anything risky.',
  disclosure: 'Additional instructions',
  guidanceLabel: 'Additional instructions',
  guidanceHelp:
    'Describe what your deployment considers routine or risky. Optional.',
  guidancePlaceholder:
    'Reading and searching are routine. Anything sent to customers is risky.',
  save: 'Save changes',
  unavailable: 'Auto mode isn’t available yet.',
};

const MODES: { mode: IntegrationToolAutoMode; label: string; hint: string }[] =
  [
    { mode: 'off', label: 'Off', hint: COPY.off },
    { mode: 'on', label: 'On', hint: COPY.on },
  ];

/**
 * Deployment-wide Auto mode for tool approvals. Rendered on the
 * Integrations page, only while the experiment is on. Reject is never affected, and the model can only ever run a call
 * or ask; it never rejects one.
 */
export function IntegrationToolAutoModeSetting() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const settings = useQuery(
    trpc.integrationToolPolicies.getAuto.queryOptions(),
  );
  const [policy, setPolicy] = useState('');
  const [guidanceOpen, setGuidanceOpen] = useState(false);
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
  // LLM call per tool call, so it is never used. The person just sees that
  // On is not available yet.
  const available = settings.data.model?.kind === 'judgment';
  const policyDirty = policy.trim() !== settings.data.policy;

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">{COPY.description}</p>
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
              disabled={save.isPending || (option.mode === 'on' && !available)}
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
      {available ? null : (
        <p className="text-sm text-muted-foreground">{COPY.unavailable}</p>
      )}
      <Collapsible open={guidanceOpen} onOpenChange={setGuidanceOpen}>
        <CollapsibleTrigger className="group flex cursor-pointer items-center gap-1.5 text-left text-sm text-muted-foreground hover:text-foreground">
          <ChevronDown
            className="size-4 shrink-0 transition-transform"
            style={{ transform: guidanceOpen ? undefined : 'rotate(-90deg)' }}
          />
          {COPY.disclosure}
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-3 flex flex-col gap-2">
          <Label htmlFor="integration-tool-auto-policy" className="sr-only">
            {COPY.guidanceLabel}
          </Label>
          {COPY.guidanceHelp ? (
            <p className="text-sm text-muted-foreground">{COPY.guidanceHelp}</p>
          ) : null}
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
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
