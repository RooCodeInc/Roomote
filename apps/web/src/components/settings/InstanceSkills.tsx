'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { createCustomSkillInputSchema } from '@roomote/types';
import type { z } from 'zod';
import { toast } from 'sonner';
import { useTRPC } from '@/trpc/client';
import {
  BasicTooltip,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  ErrorState,
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  Input,
  Pencil,
  Skeleton,
  Textarea,
  Trash2,
} from '@/components/system';
import {
  SkillListRow,
  type SkillListFilter,
} from '@/components/settings/SkillList';

type SkillDefinition = z.infer<typeof createCustomSkillInputSchema>;
type Skill = SkillDefinition & {
  id: string;
  canManage: boolean;
  createdByName?: string | null;
};

function SkillEditor({
  skill,
  onClose,
}: {
  skill: Skill | null;
  onClose: () => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const form = useForm<SkillDefinition>({
    resolver: zodResolver(createCustomSkillInputSchema),
    defaultValues: skill
      ? {
          name: skill.name,
          description: skill.description,
          content: skill.content,
        }
      : { name: '', description: '', content: '' },
  });
  const onSuccess = async () => {
    await queryClient.invalidateQueries({
      queryKey: trpc.instanceSkills.pathKey(),
    });
    toast.success(skill ? 'Skill updated' : 'Skill created');
    onClose();
  };
  const onError = (error: { message: string }) => toast.error(error.message);
  const create = useMutation(
    trpc.instanceSkills.create.mutationOptions({ onSuccess, onError }),
  );
  const update = useMutation(
    trpc.instanceSkills.update.mutationOptions({ onSuccess, onError }),
  );
  const isSaving = create.isPending || update.isPending;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !isSaving) onClose();
      }}
    >
      <DialogContent size="2xl">
        <DialogHeader>
          <DialogTitle>{skill ? 'Edit Skill' : 'Add Custom Skill'}</DialogTitle>
          <DialogDescription>
            Available across this instance in Sessions and coding tasks.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            className="space-y-4"
            onSubmit={form.handleSubmit(
              (values) => {
                if (skill) update.mutate({ ...values, skillId: skill.id });
                else create.mutate(values);
              },
              () => {
                const result = createCustomSkillInputSchema.safeParse(
                  form.getValues(),
                );
                if (!result.success)
                  toast.error(
                    result.error.issues[0]?.message ??
                      'Check the skill fields.',
                  );
              },
            )}
          >
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Slug</FormLabel>
                  <FormControl>
                    <Input
                      {...field}
                      placeholder="my-skill"
                      maxLength={64}
                      autoCapitalize="off"
                      autoCorrect="off"
                      spellCheck={false}
                      disabled={isSaving}
                    />
                  </FormControl>
                  <p className="text-sm text-muted-foreground">
                    Use lowercase letters, numbers, and hyphens.
                  </p>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Description</FormLabel>
                  <p className="text-sm text-muted-foreground">
                    Tell the agent when to use this skill.
                  </p>
                  <FormControl>
                    <Textarea
                      {...field}
                      rows={2}
                      maxLength={1024}
                      disabled={isSaving}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="content"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Content</FormLabel>
                  <FormControl>
                    <Textarea
                      {...field}
                      rows={22}
                      spellCheck={false}
                      className="font-mono text-xs"
                      disabled={isSaving}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={isSaving}
                onClick={onClose}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={isSaving}>
                {isSaving ? 'Saving...' : 'Save Skill'}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

export function InstanceSkills({
  filter,
  search,
}: {
  filter: SkillListFilter;
  search: string;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const list = useQuery(trpc.instanceSkills.list.queryOptions());
  const [editor, setEditor] = useState<{ skill: Skill | null } | null>(null);
  const [viewing, setViewing] = useState<Skill | null>(null);
  const [deleting, setDeleting] = useState<Skill | null>(null);
  const remove = useMutation(
    trpc.instanceSkills.delete.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({
          queryKey: trpc.instanceSkills.pathKey(),
        });
        toast.success('Skill deleted');
        setDeleting(null);
      },
      onError: (error) => toast.error(error.message),
    }),
  );
  const normalizedSearch = search.trim().toLowerCase();
  const visibleSkills =
    filter === 'environment'
      ? []
      : (list.data ?? []).filter((skill) =>
          [
            skill.name,
            skill.description,
            skill.createdByName ?? '',
            'Everywhere',
          ]
            .join(' ')
            .toLowerCase()
            .includes(normalizedSearch),
        );

  return (
    <>
      {list.isPending ? (
        filter !== 'environment' ? (
          <div data-testid="shared-skills-skeleton">
            {Array.from({ length: 2 }).map((_, index) => (
              <div key={index} className="flex items-start gap-3 px-4 py-3">
                <Skeleton className="size-4" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-48" />
                  <Skeleton className="h-3 w-full max-w-lg" />
                </div>
              </div>
            ))}
          </div>
        ) : null
      ) : list.isError ? (
        filter !== 'environment' ? (
          <div className="px-4 py-6">
            <ErrorState
              title="Failed to load skills"
              description={list.error.message}
            />
          </div>
        ) : null
      ) : visibleSkills.length === 0 ? (
        filter === 'shared' ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">
            {normalizedSearch
              ? 'No shared skills match your search.'
              : 'No shared skills yet. Add a custom skill to share reusable instructions with your team.'}
          </p>
        ) : null
      ) : (
        visibleSkills.map((skill) => (
          <SkillListRow
            key={skill.id}
            name={
              <button
                type="button"
                className="max-w-full truncate rounded-sm text-left hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => setViewing(skill)}
                aria-label={`View ${skill.name}`}
              >
                {skill.name}
              </button>
            }
            summary={`Created by ${skill.createdByName ?? 'Unknown'}`}
            description={
              <p className="line-clamp-2 break-words">{skill.description}</p>
            }
            availability={<span>Everywhere</span>}
            actions={
              skill.canManage ? (
                <>
                  <BasicTooltip content="Edit">
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      aria-label={`Edit ${skill.name}`}
                      onClick={() => setEditor({ skill })}
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
                </>
              ) : undefined
            }
          />
        ))
      )}
      {editor ? (
        <SkillEditor skill={editor.skill} onClose={() => setEditor(null)} />
      ) : null}
      <Dialog
        open={viewing !== null}
        onOpenChange={(open) => {
          if (!open) setViewing(null);
        }}
      >
        <DialogContent size="2xl">
          <DialogHeader>
            <DialogTitle>{viewing?.name}</DialogTitle>
            <DialogDescription>{viewing?.description}</DialogDescription>
          </DialogHeader>
          <pre className="whitespace-pre-wrap break-words font-mono text-xs">
            {viewing?.content}
          </pre>
          <DialogFooter>
            <Button variant="outline" onClick={() => setViewing(null)}>
              Close
            </Button>
          </DialogFooter>
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
            <DialogTitle>Delete Skill</DialogTitle>
            <DialogDescription>
              Delete {deleting?.name} from this instance? This cannot be undone.
              Currently running tasks will not reload their skills.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={remove.isPending}
              onClick={() => setDeleting(null)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => {
                if (deleting) remove.mutate({ skillId: deleting.id });
              }}
            >
              {remove.isPending ? 'Deleting...' : 'Delete Skill'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
