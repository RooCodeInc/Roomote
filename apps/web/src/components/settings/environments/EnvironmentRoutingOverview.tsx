'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  ALL_REPOSITORIES,
  type WorkspaceRoutingSettings,
} from '@roomote/types';
import { GitBranch, Pencil, Plus, Trash2 } from '@/components/system';
import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
} from '@/components/system';
import { Section } from '@/components/settings';
import {
  useEnvironments,
  useUpdateWorkspaceRoutingSettings,
  useWorkspaceRoutingSettings,
} from '@/hooks/environments';

const EMPTY_RULE = { description: '', target: '' };

export function EnvironmentRoutingOverview() {
  const environments = useEnvironments();
  const settings = useWorkspaceRoutingSettings();
  const updateSettings = useUpdateWorkspaceRoutingSettings();
  const [rules, setRules] = useState<WorkspaceRoutingSettings['rules']>([]);
  const [draftRule, setDraftRule] = useState(EMPTY_RULE);

  useEffect(() => {
    setRules(settings.data?.rules ?? []);
  }, [settings.data]);

  if (environments.isPending || settings.isPending) {
    return (
      <Section icon={GitBranch} title="Routing Rules">
        <Skeleton className="h-24 w-full" />
      </Section>
    );
  }

  const saveRules = async (nextRules: WorkspaceRoutingSettings['rules']) => {
    await updateSettings.mutateAsync({ rules: nextRules });
    setRules(nextRules);
    toast.success('Routing rules updated');
  };

  return (
    <Section
      icon={GitBranch}
      title="Routing Rules"
      action={
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={rules.length >= 20}
          onClick={() => setDraftRule(EMPTY_RULE)}
        >
          <Plus />
          Add Rule
        </Button>
      }
    >
      <p className="text-sm text-muted-foreground">
        Routing rules help Roomote agents pick the right environment or broad
        workspace.
      </p>

      <div className="rounded-md border border-border">
        <div className="grid gap-3 border-b border-border p-4 sm:grid-cols-[1fr_16rem_auto]">
          <Input
            value={draftRule.description}
            placeholder="Description..."
            aria-label="Rule description"
            onChange={(event) =>
              setDraftRule((current) => ({
                ...current,
                description: event.target.value.slice(0, 500),
              }))
            }
          />
          <TargetSelect
            value={draftRule.target}
            environments={environments.data ?? []}
            onChange={(target) =>
              setDraftRule((current) => ({ ...current, target }))
            }
          />
          <Button
            type="button"
            size="sm"
            disabled={
              updateSettings.isPending ||
              !draftRule.description.trim() ||
              !draftRule.target
            }
            onClick={async () => {
              try {
                const nextRules = [
                  ...rules,
                  { ...draftRule, description: draftRule.description.trim() },
                ];
                await saveRules(nextRules);
                setDraftRule(EMPTY_RULE);
              } catch {
                toast.error('Failed to add routing rule');
              }
            }}
          >
            Add Rule
          </Button>
        </div>

        <div className="grid grid-cols-[1fr_16rem_4rem] gap-3 border-b border-border px-4 py-2 text-xs font-medium text-muted-foreground max-sm:hidden">
          <span>Description</span>
          <span>Target</span>
          <span />
        </div>

        {rules.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">
            No routing rules configured.
          </p>
        ) : (
          rules.map((rule, index) => (
            <div
              key={`${rule.description}-${rule.target}-${index}`}
              className="grid gap-3 border-b border-border p-4 last:border-b-0 sm:grid-cols-[1fr_16rem_4rem] sm:items-center"
            >
              <span className="text-sm">{rule.description}</span>
              <span className="text-sm text-muted-foreground">
                {rule.target === ALL_REPOSITORIES
                  ? 'All repositories'
                  : environments.data?.find(
                      (environment) => environment.id === rule.target,
                    )?.name || rule.target}
              </span>
              <div className="flex justify-end gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Edit ${rule.description}`}
                  onClick={async () => {
                    try {
                      await saveRules(rules.filter((_, i) => i !== index));
                      setDraftRule(rule);
                    } catch {
                      toast.error('Failed to edit routing rule');
                    }
                  }}
                >
                  <Pencil />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Delete ${rule.description}`}
                  onClick={async () => {
                    try {
                      await saveRules(rules.filter((_, i) => i !== index));
                    } catch {
                      toast.error('Failed to delete routing rule');
                    }
                  }}
                >
                  <Trash2 />
                </Button>
              </div>
            </div>
          ))
        )}
      </div>
    </Section>
  );
}

function TargetSelect({
  value,
  environments,
  onChange,
}: {
  value: string;
  environments: Array<{ id: string; name: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger aria-label="Rule target">
        <SelectValue placeholder="Select target" />
      </SelectTrigger>
      <SelectContent>
        {environments.map((environment) => (
          <SelectItem key={environment.id} value={environment.id}>
            {environment.name}
          </SelectItem>
        ))}
        <SelectItem value={ALL_REPOSITORIES}>All repositories</SelectItem>
      </SelectContent>
    </Select>
  );
}
