'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import type {
  AuthorshipRuleActor,
  AuthorshipRuleIssue,
  CompiledAuthorshipRule,
} from '@roomote/types';

import { useTRPC } from '@/trpc/client';

import {
  AlertCircle,
  Badge,
  Button,
  Label,
  ScrollText,
  Skeleton,
  Textarea,
} from '@/components/system';

import { Section } from '@/components/settings';

function formatRuleActor(actor: AuthorshipRuleActor | null | undefined) {
  if (!actor) {
    return 'Specific user';
  }

  if (actor.displayName) {
    return actor.displayName;
  }

  if (actor.githubLogin) {
    return `@${actor.githubLogin}`;
  }

  return actor.userId ?? 'Specific user';
}

function formatRuleValue(value: string) {
  return value
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function describeAuthorDecision(rule: CompiledAuthorshipRule) {
  switch (rule.author.mode) {
    case 'roomote':
      return 'Author: Roomote';
    case 'matched_human':
      return 'Author: Matched human';
    case 'specific_user':
      return `Author: ${formatRuleActor(rule.author.actor)}`;
    case 'unchanged':
    default:
      return 'Author: Keep default';
  }
}

function describePrOwnerDecision(rule: CompiledAuthorshipRule) {
  switch (rule.prOwner.mode) {
    case 'inherit_author':
      return 'PR owner: Inherit author';
    case 'matched_human':
      return 'PR owner: Matched human';
    case 'specific_user':
      return `PR owner: ${formatRuleActor(rule.prOwner.actor)}`;
    case 'none':
      return 'PR owner: None';
    case 'unchanged':
    default:
      return 'PR owner: Keep default';
  }
}

function getRuleConditions(rule: CompiledAuthorshipRule) {
  const conditions: string[] = [];

  if (typeof rule.conditions.humanCreated === 'boolean') {
    conditions.push(
      rule.conditions.humanCreated ? 'Human-created' : 'Non-human',
    );
  }

  for (const sourceKind of rule.conditions.sourceKinds) {
    conditions.push(`Source: ${formatRuleValue(sourceKind)}`);
  }

  for (const taskType of rule.conditions.taskTypes) {
    conditions.push(`Task: ${formatRuleValue(taskType)}`);
  }

  for (const repositoryFullName of rule.conditions.repositoryFullNames) {
    conditions.push(`Repo: ${repositoryFullName}`);
  }

  return conditions;
}

function formatCompiledAt(value: Date | string | null | undefined) {
  if (!value) {
    return null;
  }

  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toLocaleString();
}

function IssueList({ issues }: { issues: AuthorshipRuleIssue[] }) {
  if (issues.length === 0) {
    return null;
  }

  return (
    <div className="space-y-2 rounded-lg border border-border/70 bg-muted/20 p-3">
      <div className="flex items-center gap-2">
        <AlertCircle className="size-4 text-muted-foreground" />
        <p className="text-sm font-medium">Compiler feedback</p>
      </div>
      <ul className="space-y-2 text-sm">
        {issues.map((issue, index) => (
          <li key={`${issue.severity}-${index}`} className="flex gap-2">
            <Badge
              variant={issue.severity === 'error' ? 'destructive' : 'warning'}
              className="mt-0.5"
            >
              {issue.severity}
            </Badge>
            <span className="text-muted-foreground">{issue.message}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function RulePreview({ rules }: { rules: CompiledAuthorshipRule[] }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <p className="text-sm font-medium">Parsed rules</p>
        <Badge variant="secondary">{rules.length}</Badge>
      </div>
      {rules.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No override rules are active. Defaults apply.
        </p>
      ) : (
        <div className="space-y-3">
          {rules.map((rule) => {
            const conditions = getRuleConditions(rule);

            return (
              <div
                key={rule.id}
                className="space-y-3 rounded-lg border border-border/70 p-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-medium">{rule.label}</p>
                  <Badge variant="outline">
                    {describeAuthorDecision(rule)}
                  </Badge>
                  <Badge variant="outline">
                    {describePrOwnerDecision(rule)}
                  </Badge>
                </div>
                <div className="flex flex-wrap gap-2">
                  {(conditions.length > 0 ? conditions : ['Always']).map(
                    (condition) => (
                      <Badge
                        key={`${rule.id}-${condition}`}
                        variant="secondary"
                      >
                        {condition}
                      </Badge>
                    ),
                  )}
                </div>
                <p className="text-sm text-muted-foreground">
                  {rule.rationale}
                </p>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function AuthorshipRulesSection() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const settingsQueryKey = trpc.agentBehavior.get.queryKey();
  const settingsQuery = useQuery(trpc.agentBehavior.get.queryOptions());
  const [value, setValue] = useState('');
  const [savedValue, setSavedValue] = useState('');
  const [hasLoadedInitialValue, setHasLoadedInitialValue] = useState(false);

  const updateMutation = useMutation(
    trpc.agentBehavior.update.mutationOptions({
      onSuccess: (result) => {
        if (!result.success) {
          return;
        }

        queryClient.setQueryData(settingsQueryKey, result.settings);
        const nextValue = result.settings.authorshipInstructions ?? '';
        setValue(nextValue);
        setSavedValue(nextValue);
        toast.success(
          result.settings.compiledAuthorshipIssues.some(
            (issue) => issue.severity === 'error',
          )
            ? 'Authorship rules saved with issues.'
            : 'Authorship rules saved.',
        );
      },
      onError: () => {
        toast.error('Failed to save authorship rules.');
      },
      onSettled: () => {
        void queryClient.invalidateQueries({
          queryKey: settingsQueryKey,
        });
      },
    }),
  );

  const serverValue = settingsQuery.data?.authorshipInstructions ?? '';
  const isDirty = value !== savedValue;

  useEffect(() => {
    if (!settingsQuery.data) {
      return;
    }

    if (!hasLoadedInitialValue || !isDirty) {
      setValue(serverValue);
      setSavedValue(serverValue);
      setHasLoadedInitialValue(true);
    }
  }, [hasLoadedInitialValue, isDirty, serverValue, settingsQuery.data]);

  const fieldError =
    updateMutation.data && !updateMutation.data.success
      ? updateMutation.data.fieldErrors.authorshipInstructions
      : undefined;
  const compiledAt = formatCompiledAt(settingsQuery.data?.compiledAuthorshipAt);
  const compiledIssues = settingsQuery.data?.compiledAuthorshipIssues ?? [];
  const compiledRules = settingsQuery.data?.compiledAuthorshipRules ?? [];

  const footer =
    !isDirty && !updateMutation.isPending ? undefined : (
      <>
        <Button
          variant="outline"
          type="button"
          onClick={() => {
            setValue(savedValue);
            updateMutation.reset();
          }}
          disabled={updateMutation.isPending}
        >
          Reset
        </Button>
        <Button
          type="button"
          onClick={() =>
            updateMutation.mutate({
              authorshipInstructions: value || null,
            })
          }
          disabled={updateMutation.isPending}
        >
          {updateMutation.isPending ? 'Saving...' : 'Save'}
        </Button>
      </>
    );

  return (
    <Section icon={ScrollText} title="Authorship Rules" footer={footer}>
      <div className="space-y-3">
        <p>
          Natural-language rules that set the effective author and default PR
          owner for autonomous work. When nothing matches, Roomote authors the
          work, human-created tasks keep the human author, and PR ownership
          follows the effective author.
        </p>
        {settingsQuery.isPending ? (
          <div className="space-y-3">
            <Skeleton className="h-64 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : settingsQuery.isError ? (
          <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <p>Failed to load authorship rules.</p>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-3">
              <Label htmlFor="authorship-instructions" className="sr-only">
                Authorship Rules
              </Label>
              <Textarea
                id="authorship-instructions"
                value={value}
                onChange={(event) => {
                  if (fieldError) {
                    updateMutation.reset();
                  }

                  setValue(event.target.value);
                }}
                className="min-h-64"
                rows={14}
                placeholder="Examples: For work opened from GitHub in owner/repo, keep the matched human as the author. For maintenance jobs, make Roomote the author and leave PR owner empty."
                disabled={updateMutation.isPending}
              />
              {fieldError && (
                <p className="text-xs text-destructive">{fieldError}</p>
              )}
              {compiledAt && (
                <p className="text-xs text-muted-foreground">
                  Last compiled {compiledAt}
                </p>
              )}
            </div>
            <IssueList issues={compiledIssues} />
            <RulePreview rules={compiledRules} />
          </div>
        )}
      </div>
    </Section>
  );
}
