'use client';

import type { ReactNode } from 'react';

import { type EnvironmentRepositoryConfig } from '@roomote/types';

import {
  Button,
  GitBranch,
  InfoTooltip,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Trash2,
} from '@/components/system';

import { CommandListEditor } from './CommandListEditor';
import { KeyValueListEditor } from './KeyValueListEditor';
import {
  trimToUndefined,
  type RepositoryOption,
} from './VisualEnvironmentEditor.model';

export function RepositoryEditor({
  repository,
  onChange,
  onRemove,
  removable,
  fieldId,
  repositoryOptions,
}: {
  repository: EnvironmentRepositoryConfig;
  onChange: (next: EnvironmentRepositoryConfig) => void;
  onRemove: () => void;
  removable: boolean;
  fieldId: string;
  repositoryOptions: RepositoryOption[];
}) {
  const updateRepository = (
    mutate: (draft: EnvironmentRepositoryConfig) => void,
  ) => {
    const next = structuredClone(repository);
    mutate(next);
    onChange(next);
  };
  const repositorySelectOptions = repositoryOptions.some(
    (option) => option.fullName === repository.repository,
  )
    ? repositoryOptions
    : repository.repository
      ? [
          {
            id: `current-${repository.repository}`,
            fullName: repository.repository,
          },
          ...repositoryOptions,
        ]
      : repositoryOptions;

  return (
    <div className="space-y-5 rounded-xl border border-border/70 bg-background/70 p-5">
      <RepositoryEditorRow
        label={
          <Label htmlFor={`${fieldId}-repository`} className="text-xs">
            Repository
          </Label>
        }
      >
        <div className="grid gap-2 md:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)_auto]">
          <Select
            value={repository.repository}
            disabled={repositorySelectOptions.length === 0}
            onValueChange={(nextRepository) =>
              updateRepository((draft) => {
                draft.repository = nextRepository;
              })
            }
          >
            <SelectTrigger
              id={`${fieldId}-repository`}
              aria-label="Repository"
              className="w-full"
            >
              <SelectValue placeholder="Select repository" />
            </SelectTrigger>
            <SelectContent>
              {repositorySelectOptions.map((option) => (
                <SelectItem key={option.id} value={option.fullName}>
                  {option.fullName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="grid grid-cols-[1.5rem_minmax(0,1fr)] items-center gap-2">
            <Label
              htmlFor={`${fieldId}-branch`}
              className="flex items-center justify-center"
            >
              <InfoTooltip
                icon={GitBranch}
                iconClassName="size-4"
                content="The branch to check out before setup runs. Leave blank to use the repository default branch."
              />
            </Label>
            <Input
              id={`${fieldId}-branch`}
              aria-label="Branch"
              value={repository.branch ?? ''}
              placeholder="Branch"
              className="font-mono"
              onChange={(event) =>
                updateRepository((draft) => {
                  const nextBranch = trimToUndefined(event.target.value);
                  if (nextBranch) {
                    draft.branch = nextBranch;
                  } else {
                    delete draft.branch;
                  }
                })
              }
            />
          </div>
          <div className="flex items-center justify-end">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={`Remove ${repository.repository || 'repository'}`}
              disabled={!removable}
              onClick={onRemove}
            >
              <Trash2 />
            </Button>
          </div>
        </div>
      </RepositoryEditorRow>

      <RepositoryEditorRow
        label={
          <div className="flex items-center gap-1.5">
            <Label className="text-xs">Repo tool fallbacks</Label>
            <InfoTooltip content="Adds repo-specific fallback tools via mise and runs mise install there. Checked-in repo tool config still wins; these entries only fill missing tools for this repo." />
          </div>
        }
      >
        <KeyValueListEditor
          value={repository.tool_versions}
          onChange={(next) =>
            updateRepository((draft) => {
              if (next) {
                draft.tool_versions = next;
              } else {
                delete draft.tool_versions;
              }
            })
          }
          keyLabel="Tool"
          valueLabel="Version"
          emptyLabel="No tool versions"
          addLabel="Add tool"
          inputClassName="font-mono"
        />
      </RepositoryEditorRow>

      <RepositoryEditorRow
        label={
          <Label className="text-xs">
            Commands
            <InfoTooltip content="The commands to be run during the environment setup to have all services working properly. It's probably the same you'd have to do in your local dev environment." />
          </Label>
        }
      >
        <CommandListEditor
          commands={repository.commands}
          onChange={(next) =>
            updateRepository((draft) => {
              if (next) {
                draft.commands = next;
              } else {
                delete draft.commands;
              }
            })
          }
        />
      </RepositoryEditorRow>
    </div>
  );
}

function RepositoryEditorRow({
  label,
  children,
}: {
  label: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-3 md:grid-cols-[8.5rem_minmax(0,1fr)] md:gap-6">
      <div className="flex h-9 items-center whitespace-nowrap">{label}</div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
