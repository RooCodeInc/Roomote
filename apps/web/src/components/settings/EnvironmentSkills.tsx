'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { useTRPC } from '@/trpc/client';
import {
  BasicTooltip,
  Button,
  Card,
  CardContent,
  Checkbox,
  ChevronDown,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Eye,
  Input,
  Label,
  Pencil,
  Plus,
  Skeleton,
  Textarea,
  Trash2,
  VectorSquare,
} from '@/components/system';

const DEFAULT_SKILL = {
  name: 'my-environment-skill',
  description: 'Adds custom Roomote behavior.',
  content:
    '# My Environment Skill\n\nUse this skill when you need custom instructions.',
  selectedEnvironmentIds: [] as string[],
};
const INVALID_NAME_CHARACTER = /[/\s]+/g;

type Environment = { id: string; name: string };
type EnvironmentSkill = {
  kind: 'manual';
  source: string;
  name: string;
  skillId: string;
  isAllSelection: boolean;
  installsLabel: string | null;
  url: string | null;
  description: string | null;
  content: string | null;
  environments: Environment[];
};
type EditorState = {
  previousSkillId?: string;
  name: string;
  description: string;
  content: string;
  selectedEnvironmentIds: string[];
};

function sameEditorState(left: EditorState | null, right: EditorState | null) {
  if (!left || !right) return left === right;
  return (
    left.previousSkillId === right.previousSkillId &&
    left.name === right.name &&
    left.description === right.description &&
    left.content === right.content &&
    left.selectedEnvironmentIds.length ===
      right.selectedEnvironmentIds.length &&
    left.selectedEnvironmentIds.every(
      (environmentId, index) =>
        environmentId === right.selectedEnvironmentIds[index],
    )
  );
}

function sortedEnvironmentIds(ids: string[], environments: Environment[]) {
  const names = new Map(
    environments.map((environment) => [environment.id, environment.name]),
  );
  return [...ids].sort((left, right) =>
    (names.get(left) ?? left).localeCompare(names.get(right) ?? right),
  );
}

export function EnvironmentSkills() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const list = useQuery(trpc.customSkills.list.queryOptions());
  const environments = list.data?.environments ?? [];
  const skills = (list.data?.installed ?? []).filter(
    (skill): skill is EnvironmentSkill => skill.kind === 'manual',
  );
  const [viewing, setViewing] = useState<EnvironmentSkill | null>(null);
  const [editing, setEditing] = useState<EditorState | null>(null);
  const [initialEditor, setInitialEditor] = useState<EditorState | null>(null);
  const [deleting, setDeleting] = useState<EnvironmentSkill | null>(null);

  const save = useMutation(
    trpc.customSkills.saveManual.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({
          queryKey: trpc.customSkills.list.queryKey(),
        });
        toast.success(
          editing?.previousSkillId
            ? 'Environment skill updated'
            : 'Environment skill created',
        );
        setEditing(null);
        setInitialEditor(null);
      },
      onError: (error) => toast.error(error.message),
    }),
  );
  const remove = useMutation(
    trpc.customSkills.remove.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({
          queryKey: trpc.customSkills.list.queryKey(),
        });
        toast.success('Environment skill deleted');
        setDeleting(null);
      },
      onError: (error) => toast.error(error.message),
    }),
  );

  const openEditor = (skill?: EnvironmentSkill) => {
    const nextState = skill
      ? {
          previousSkillId: skill.skillId,
          name: skill.name,
          description: skill.description ?? '',
          content: skill.content ?? '',
          selectedEnvironmentIds: sortedEnvironmentIds(
            skill.environments.map((environment) => environment.id),
            environments,
          ),
        }
      : { ...DEFAULT_SKILL };
    setInitialEditor(nextState);
    setEditing(nextState);
  };

  const closeEditor = () => {
    if (!editing || save.isPending) return;
    if (
      !sameEditorState(editing, initialEditor) &&
      !window.confirm('Discard unsaved changes to this environment skill?')
    ) {
      return;
    }
    setEditing(null);
    setInitialEditor(null);
  };

  if (list.isSuccess && environments.length === 0) return null;

  if (list.isPending) {
    return (
      <div className="border-t pt-4" data-testid="environment-skills-skeleton">
        <Skeleton className="h-5 w-44" />
      </div>
    );
  }

  if (list.isError) {
    return (
      <p className="border-t pt-4 text-sm text-destructive">
        Failed to load environment skills.
      </p>
    );
  }

  return (
    <>
      <details className="group border-t pt-4">
        <summary className="flex cursor-pointer list-none items-center gap-2 text-sm text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
          <ChevronDown className="size-4 -rotate-90 group-open:rotate-0" />
          Environment skills
        </summary>
        <div className="space-y-4 pt-4">
          <div className="flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
            <p className="text-sm text-muted-foreground">
              Admin-managed skills available only in selected environments.
            </p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => openEditor()}
            >
              <Plus />
              Add environment skill
            </Button>
          </div>

          {skills.length > 0 ? (
            <Card variant="snug">
              <CardContent>
                <ul
                  className="divide-y divide-background"
                  aria-label="Environment skills"
                >
                  {skills.map((skill) => (
                    <li
                      key={skill.skillId}
                      className="flex items-start justify-between gap-3 py-3 first:pt-0 last:pb-0"
                    >
                      <div className="min-w-0 flex-1 space-y-1">
                        <p className="break-words text-sm font-semibold">
                          {skill.name}
                        </p>
                        {skill.description ? (
                          <p className="line-clamp-2 break-words text-sm text-muted-foreground">
                            {skill.description}
                          </p>
                        ) : null}
                        <p className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                          <VectorSquare className="size-3" />
                          {skill.environments
                            .map((environment) => environment.name)
                            .join(', ')}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <BasicTooltip content="View">
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            aria-label={`View ${skill.name}`}
                            onClick={() => setViewing(skill)}
                          >
                            <Eye />
                          </Button>
                        </BasicTooltip>
                        <BasicTooltip content="Edit">
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            aria-label={`Edit ${skill.name}`}
                            onClick={() => openEditor(skill)}
                          >
                            <Pencil />
                          </Button>
                        </BasicTooltip>
                        <BasicTooltip content="Delete">
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            aria-label={`Delete ${skill.name}`}
                            onClick={() => setDeleting(skill)}
                          >
                            <Trash2 />
                          </Button>
                        </BasicTooltip>
                      </div>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ) : (
            <p className="text-sm text-muted-foreground">
              No environment skills yet.
            </p>
          )}
        </div>
      </details>

      <Dialog
        open={viewing !== null}
        onOpenChange={(open) => !open && setViewing(null)}
      >
        <DialogContent size="2xl">
          <DialogHeader>
            <DialogTitle>{viewing?.name}</DialogTitle>
            <DialogDescription>{viewing?.description}</DialogDescription>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Enabled in{' '}
            {viewing?.environments
              .map((environment) => environment.name)
              .join(', ')}
          </p>
          <pre className="whitespace-pre-wrap break-words font-mono text-xs">
            {viewing?.content}
          </pre>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setViewing(null)}
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) closeEditor();
        }}
      >
        <DialogContent size="2xl">
          {editing ? (
            <>
              <DialogHeader>
                <DialogTitle>
                  {editing.previousSkillId
                    ? 'Edit Environment Skill'
                    : 'Add Environment Skill'}
                </DialogTitle>
                <DialogDescription>
                  Choose which environments can use these instructions.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="environment-skill-name">Slug</Label>
                  <Input
                    id="environment-skill-name"
                    value={editing.name}
                    onChange={(event) =>
                      setEditing({
                        ...editing,
                        name: event.currentTarget.value.replace(
                          INVALID_NAME_CHARACTER,
                          '',
                        ),
                      })
                    }
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    disabled={save.isPending}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="environment-skill-description">
                    Description
                  </Label>
                  <p className="text-sm text-muted-foreground">
                    Tell the agent when to use this skill.
                  </p>
                  <Textarea
                    id="environment-skill-description"
                    value={editing.description}
                    onChange={(event) =>
                      setEditing({
                        ...editing,
                        description: event.currentTarget.value,
                      })
                    }
                    rows={2}
                    disabled={save.isPending}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="environment-skill-content">Content</Label>
                  <Textarea
                    id="environment-skill-content"
                    value={editing.content}
                    onChange={(event) =>
                      setEditing({
                        ...editing,
                        content: event.currentTarget.value,
                      })
                    }
                    rows={18}
                    spellCheck={false}
                    className="font-mono text-xs"
                    disabled={save.isPending}
                  />
                </div>
                <fieldset className="space-y-2 text-sm">
                  <legend>Enable in</legend>
                  {environments.map((environment) => (
                    <label
                      key={environment.id}
                      htmlFor={`environment-skill-${environment.id}`}
                      className="flex cursor-pointer items-center gap-2"
                    >
                      <Checkbox
                        id={`environment-skill-${environment.id}`}
                        checked={editing.selectedEnvironmentIds.includes(
                          environment.id,
                        )}
                        onCheckedChange={() => {
                          const selected =
                            editing.selectedEnvironmentIds.includes(
                              environment.id,
                            );
                          setEditing({
                            ...editing,
                            selectedEnvironmentIds: sortedEnvironmentIds(
                              selected
                                ? editing.selectedEnvironmentIds.filter(
                                    (id) => id !== environment.id,
                                  )
                                : [
                                    ...editing.selectedEnvironmentIds,
                                    environment.id,
                                  ],
                              environments,
                            ),
                          });
                        }}
                        disabled={save.isPending}
                      />
                      <VectorSquare className="size-4" />
                      {environment.name}
                    </label>
                  ))}
                </fieldset>
              </div>
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={closeEditor}
                  disabled={save.isPending}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  disabled={
                    save.isPending ||
                    editing.name.trim().length === 0 ||
                    editing.description.trim().length === 0 ||
                    editing.content.trim().length === 0 ||
                    editing.selectedEnvironmentIds.length === 0
                  }
                  onClick={() =>
                    save.mutate({
                      name: editing.name,
                      description: editing.description,
                      content: editing.content,
                      environmentIds: editing.selectedEnvironmentIds,
                      previousSkillId: editing.previousSkillId,
                    })
                  }
                >
                  {save.isPending ? 'Saving...' : 'Save Skill'}
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open && !remove.isPending) setDeleting(null);
        }}
      >
        <DialogContent size="md">
          <DialogHeader>
            <DialogTitle>Delete Environment Skill</DialogTitle>
            <DialogDescription>
              Delete {deleting?.name} from its selected environments? This
              cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={remove.isPending}
              onClick={() => setDeleting(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={remove.isPending}
              onClick={() =>
                deleting && remove.mutate({ skillId: deleting.skillId })
              }
            >
              {remove.isPending ? 'Deleting...' : 'Delete Skill'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
