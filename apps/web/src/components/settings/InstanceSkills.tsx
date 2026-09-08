'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { createCustomSkillInputSchema } from '@roomote/types';
import type { z } from 'zod';
import { toast } from 'sonner';
import { useTRPC } from '@/trpc/client';
import { Section } from '@/components/settings/Section';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  ErrorState,
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  GraduationCap,
  Input,
  Pencil,
  Plus,
  Skeleton,
  Textarea,
  Trash2,
} from '@/components/system';

type SkillDefinition = z.infer<typeof createCustomSkillInputSchema>;
type Skill = SkillDefinition & { id: string; canManage: boolean };

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

export function InstanceSkills() {
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
    <Section
      icon={GraduationCap}
      title="Instance skills"
      action={
        <Button onClick={() => setEditor({ skill: null })}>
          <Plus />
          Add Skill
        </Button>
      }
    >
      <p className="text-sm text-muted-foreground">
        Available to all Sessions and coding tasks. Changes do not reload skills
        in currently running tasks. Any member can add a skill; only its creator
        or an admin can edit or delete it.
      </p>
      {list.isPending ? (
        <div className="space-y-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : list.isError ? (
        <ErrorState
          title="Failed to load instance skills"
          description={list.error.message}
        />
      ) : list.data.length === 0 ? (
        <EmptyState
          title="No instance skills yet"
          description="Add a reusable skill for everyone on this instance."
        />
      ) : (
        <ul className="divide-y">
          {list.data.map((skill) => (
            <li
              key={skill.id}
              className="flex flex-wrap items-center justify-between gap-3 py-3"
            >
              <div className="min-w-0 flex-1">
                <p className="break-words font-medium">{skill.name}</p>
                <p className="break-words text-sm text-muted-foreground">
                  {skill.description}
                </p>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setViewing(skill)}
                  aria-label={`View ${skill.name}`}
                >
                  View
                </Button>
                {skill.canManage ? (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setEditor({ skill })}
                      aria-label={`Edit ${skill.name}`}
                    >
                      <Pencil />
                      Edit
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setDeleting(skill)}
                      aria-label={`Delete ${skill.name}`}
                    >
                      <Trash2 />
                      Delete
                    </Button>
                  </>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
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
    </Section>
  );
}
