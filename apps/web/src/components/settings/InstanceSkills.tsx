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
  Card,
  CardContent,
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
          <DialogTitle>{skill ? 'Edit Skill' : 'Add Skill'}</DialogTitle>
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
  isCreating,
  onCloseCreate,
}: {
  isCreating: boolean;
  onCloseCreate: () => void;
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

  return (
    <>
      {list.isPending ? (
        <Card variant="snug" data-testid="shared-skills-skeleton">
          <CardContent>
            <div className="divide-y divide-background">
              {Array.from({ length: 2 }).map((_, index) => (
                <div
                  key={index}
                  className="flex items-start gap-3 py-3 first:pt-0 last:pb-0"
                >
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-4 w-48" />
                    <Skeleton className="h-3 w-full max-w-lg" />
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      ) : list.isError ? (
        <ErrorState
          title="Failed to load skills"
          description={list.error.message}
        />
      ) : list.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No shared skills yet. Add a skill to share reusable instructions with
          your team.
        </p>
      ) : (
        <Card variant="snug">
          <CardContent>
            <ul
              className="divide-y divide-background"
              aria-label="Shared skills"
            >
              {list.data.map((skill) => (
                <li
                  key={skill.id}
                  className="flex items-start justify-between gap-3 py-3 first:pt-0 last:pb-0"
                >
                  <button
                    type="button"
                    className="min-w-0 flex-1 space-y-1 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => setViewing(skill)}
                    aria-label={`View ${skill.name}`}
                  >
                    <span className="block break-words text-sm font-semibold hover:underline">
                      {skill.name}
                    </span>
                    <span className="line-clamp-2 break-words text-sm text-muted-foreground">
                      {skill.description}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      Created by {skill.createdByName ?? 'Unknown'}
                    </span>
                  </button>
                  <div className="flex shrink-0 items-center gap-1">
                    {skill.canManage ? (
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
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
      {editor ? (
        <SkillEditor skill={editor.skill} onClose={() => setEditor(null)} />
      ) : null}
      {isCreating ? <SkillEditor skill={null} onClose={onCloseCreate} /> : null}
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
