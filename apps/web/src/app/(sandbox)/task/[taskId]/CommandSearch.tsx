'use client';

import { useCallback, useMemo, useState } from 'react';
import { PACKAGED_SKILL_INVOCATIONS } from '@roomote/cloud-agents';

import {
  Command,
  CommandInput,
  CommandItem,
  CommandList,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/system';

interface CommandSearchProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectCommand: (name: string) => void;
}

interface SlashCommand {
  name: string;
  description: string;
}

const PACKAGED_SKILL_DESCRIPTIONS: Record<
  (typeof PACKAGED_SKILL_INVOCATIONS)[number],
  string
> = {
  'address-pr-feedback':
    'Address unresolved review threads on the current pull request',
  'agent-browser': 'Navigate, test, or automate a website or web application',
  'capture-visual-proof':
    'Capture screenshots or video evidence for a product change',
  'ci-failure-triage':
    'Investigate and fix the latest default-branch CI failure',
  'create-draft-pr': 'Commit changes and open or update a draft pull request',
  'create-pr': 'Commit changes and open or update a ready pull request',
  'debug-reported-bug': 'Reproduce a reported bug and trace its root cause',
  'dependabot-triage':
    'Review Dependabot alerts and launch safe dependency fixes',
  'codeql-triage': 'Review CodeQL alerts and launch focused security fixes',
  doctor: 'Check an environment by running a real task journey',
  'issue-fixer': 'Investigate an issue and post a concrete implementation plan',
  'environment-setup': 'Configure and verify a Roomote task environment',
  'explain-repo-code':
    'Explain repository behavior or architecture without editing files',
  'feature-demo': 'Record a polished browser demo of a product feature',
  'fix-pr': 'Implement requested fixes from pull request feedback',
  'github-management':
    'Manage repository labels, milestones, and GitHub projects',
  'explore-and-act': 'Investigate evidence or act in connected systems',
  'implement-repo-change': 'Legacy alias for implementing repository changes',
  'implement-changes': 'Implement, test, and deliver a repository change',
  'merge-resolution-review': 'Review a completed merge-conflict resolution',
  'merge-resolver': 'Resolve merge conflicts in the current workspace',
  'plan-repo-implementation':
    'Create an implementation plan without changing files',
  push: 'Commit and push changes without opening a pull request',
  'push-branch': 'Legacy alias for committing and pushing a branch',
  'resolve-github-pr-merge-conflicts':
    'Merge the base branch and resolve pull request conflicts',
  'review-and-fix': 'Review current changes and fix the issues found',
  'review-code': 'Review current changes without modifying them',
  'sentry-triage': 'Inspect Sentry issues and recommend focused follow-up work',
  simplify: 'Simplify recent code changes without changing behavior',
  'update-dependencies': 'Find and apply safe dependency upgrades',
  zero: 'Find an external capability when Roomote cannot do the task directly',
  'code-quality-auditor':
    'Audit recent pull requests for code quality follow-up work',
  'fix-sentry-error': 'Investigate and remediate a specific Sentry issue',
  'refactor-code': 'Survey the codebase and plan high-leverage refactors',
  'security-auditor': 'Audit recent pull requests for concrete security issues',
  'triage-better-stack':
    'Scan Better Stack telemetry for operational follow-up work',
  'triage-sentry': 'Scan Sentry for errors and regressions worth fixing',
};

const AVAILABLE_COMMANDS: SlashCommand[] = [
  {
    name: '/goal',
    description: 'Keep working toward an objective across multiple turns',
  },
  ...PACKAGED_SKILL_INVOCATIONS.map((name) => ({
    name: `/${name}`,
    description: PACKAGED_SKILL_DESCRIPTIONS[name],
  })),
];

export const CommandSearch = ({
  open,
  onOpenChange,
  onSelectCommand,
}: CommandSearchProps) => {
  const [query, setQuery] = useState('');

  const filteredCommands = useMemo(() => {
    if (!query.trim()) {
      return AVAILABLE_COMMANDS;
    }

    const normalizedQuery = query.toLowerCase();

    return AVAILABLE_COMMANDS.filter(
      (command) =>
        command.name.toLowerCase().includes(normalizedQuery) ||
        command.description.toLowerCase().includes(normalizedQuery),
    );
  }, [query]);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) {
        setQuery('');
      }

      onOpenChange(nextOpen);
    },
    [onOpenChange],
  );

  const handleSelect = useCallback(
    (name: string) => {
      onSelectCommand(name);
      handleOpenChange(false);
    },
    [handleOpenChange, onSelectCommand],
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        size="xl"
        className="overflow-hidden p-0"
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">Commands</DialogTitle>
        <DialogDescription className="sr-only">
          Search for a command to add to your message.
        </DialogDescription>
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search commands..."
            value={query}
            onValueChange={setQuery}
          />
          <CommandList>
            {filteredCommands.length === 0 ? (
              <div className="text-muted-foreground py-6 px-4 text-center text-sm">
                No commands found.
              </div>
            ) : (
              filteredCommands.map((command) => (
                <CommandItem
                  key={command.name}
                  value={command.name}
                  onSelect={() => handleSelect(command.name)}
                >
                  <span className="flex flex-col gap-2 py-1">
                    <span className="truncate font-mono text-[0.8rem]">
                      {command.name}
                    </span>
                    <span className="truncate text-xs opacity-70">
                      {command.description}
                    </span>
                  </span>
                </CommandItem>
              ))
            )}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
};
