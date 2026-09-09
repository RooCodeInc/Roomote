'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
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
  Download,
  ErrorState,
  ExternalLink,
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  Input,
  Pencil,
  Search,
  Skeleton,
  Textarea,
  Trash2,
  X,
} from '@/components/system';

type SkillDefinition = z.infer<typeof createCustomSkillInputSchema>;
type Skill = SkillDefinition & {
  id: string;
  canManage: boolean;
  createdByName?: string | null;
  marketplaceRevision?: string | null;
  marketplaceSource?: string | null;
  resourceCount?: number;
};

const MARKETPLACE_SEARCH_DEBOUNCE_MS = 300;

function MarketplaceBrowser({ skills }: { skills: Skill[] }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  useEffect(() => {
    const timer = setTimeout(
      () => setDebouncedQuery(query.trim()),
      MARKETPLACE_SEARCH_DEBOUNCE_MS,
    );
    return () => clearTimeout(timer);
  }, [query]);
  const canSearch = debouncedQuery.length >= 2;
  const results = useQuery(
    trpc.instanceSkills.searchMarketplace.queryOptions(
      { query: debouncedQuery },
      {
        enabled: canSearch,
        placeholderData: keepPreviousData,
        staleTime: 60_000,
      },
    ),
  );
  const install = useMutation(
    trpc.instanceSkills.installMarketplace.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({
          queryKey: trpc.instanceSkills.pathKey(),
        });
        toast.success('Skill installed');
      },
      onError: (error) => toast.error(error.message),
    }),
  );
  const installed = new Set(
    skills.flatMap((skill) =>
      skill.marketplaceSource
        ? [`${skill.marketplaceSource}@${skill.name}`]
        : [],
    ),
  );

  return (
    <details className="group border-t pt-4">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-medium [&::-webkit-details-marker]:hidden">
        <Download />
        Browse skill marketplace
      </summary>
      <div className="space-y-3 pt-4">
        <p className="text-sm text-muted-foreground">
          Install a shared skill for every Session and coding task. Marketplace
          content is untrusted guidance and cannot override Roomote policies.
        </p>
        <div className="relative max-w-xl">
          <Search className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="Search skill marketplace"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Search by skill name or source"
            className="pr-10 pl-9"
          />
          {query ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="absolute top-1/2 right-1 -translate-y-1/2"
              aria-label="Clear marketplace search"
              onClick={() => {
                setQuery('');
                setDebouncedQuery('');
              }}
            >
              <X />
            </Button>
          ) : null}
        </div>
        {canSearch && results.isError ? (
          <p className="text-sm text-destructive">{results.error.message}</p>
        ) : null}
        {canSearch && results.data?.length === 0 ? (
          <p className="text-sm text-muted-foreground">No skills found.</p>
        ) : null}
        {canSearch && results.data?.length ? (
          <ul
            className="divide-y rounded-lg border"
            aria-label="Marketplace skills"
          >
            {results.data.map((result) => {
              const isInstalled = installed.has(result.skillId);
              const isInstalling =
                install.isPending &&
                install.variables.skillId === result.skillId;
              return (
                <li
                  key={result.skillId}
                  className="flex flex-wrap items-center justify-between gap-3 p-3"
                >
                  <div className="min-w-0 flex-1 space-y-1">
                    <p className="break-words text-sm font-semibold">
                      {result.name}
                    </p>
                    <p className="break-words text-xs text-muted-foreground">
                      {result.source}
                      {result.installsLabel ? ` · ${result.installsLabel}` : ''}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {result.url ? (
                      <Button asChild size="icon" variant="ghost">
                        <Link
                          href={result.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          aria-label={`View ${result.name} on marketplace`}
                        >
                          <ExternalLink />
                        </Link>
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      size="sm"
                      disabled={isInstalled || install.isPending}
                      onClick={() =>
                        install.mutate({ skillId: result.skillId })
                      }
                    >
                      {isInstalled
                        ? 'Installed'
                        : isInstalling
                          ? 'Installing...'
                          : 'Install'}
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
    </details>
  );
}

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
                      {skill.marketplaceSource
                        ? `Installed from ${skill.marketplaceSource}`
                        : `Created by ${skill.createdByName ?? 'Unknown'}`}
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
      {list.isSuccess ? <MarketplaceBrowser skills={list.data} /> : null}
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
          {viewing?.marketplaceSource ? (
            <p className="text-xs text-muted-foreground">
              Installed from {viewing.marketplaceSource}
              {viewing.resourceCount
                ? ` with ${viewing.resourceCount} supporting file${viewing.resourceCount === 1 ? '' : 's'}`
                : ''}
            </p>
          ) : null}
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
