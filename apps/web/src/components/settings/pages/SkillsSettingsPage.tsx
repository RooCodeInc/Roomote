'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { createCustomSkillInputSchema } from '@roomote/types';
import type { z } from 'zod';
import { toast } from 'sonner';
import { CustomSkills } from '@/components/settings/CustomSkills';
import { SettingsShell } from '@/components/settings/SettingsShell';
import { InstanceSkills } from '@/components/settings/InstanceSkills';
import {
  SkillListHeader,
  SkillListToolbar,
  type SkillListFilter,
} from '@/components/settings/SkillList';
import { useAuthorizedUser } from '@/hooks/useUser';
import { useTRPC } from '@/trpc/client';
import {
  Button,
  Card,
  CardContent,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  Input,
  Label,
  Plus,
  RadioGroup,
  RadioGroupItem,
  Textarea,
  VectorSquare,
} from '@/components/system';

type SkillDefinition = z.infer<typeof createCustomSkillInputSchema>;
type NewSkillAvailability = 'shared' | 'environment';

function AddCustomSkillDialog({
  open,
  isAdmin,
  onOpenChange,
}: {
  open: boolean;
  isAdmin: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [availability, setAvailability] =
    useState<NewSkillAvailability>('shared');
  const [environmentIds, setEnvironmentIds] = useState<string[]>([]);
  const form = useForm<SkillDefinition>({
    resolver: zodResolver(createCustomSkillInputSchema),
    defaultValues: { name: '', description: '', content: '' },
  });
  const environments = useQuery({
    ...trpc.customSkills.list.queryOptions(),
    enabled: open && isAdmin,
  });
  const resetAndClose = () => {
    onOpenChange(false);
    setAvailability('shared');
    setEnvironmentIds([]);
    form.reset();
  };
  const finishCreate = async (queryKey: readonly unknown[]) => {
    await queryClient.invalidateQueries({ queryKey });
    toast.success('Skill created');
    resetAndClose();
  };
  const onError = (error: { message: string }) => toast.error(error.message);
  const createShared = useMutation(
    trpc.instanceSkills.create.mutationOptions({
      onSuccess: () => finishCreate(trpc.instanceSkills.pathKey()),
      onError,
    }),
  );
  const createEnvironment = useMutation(
    trpc.customSkills.saveManual.mutationOptions({
      onSuccess: () => finishCreate(trpc.customSkills.list.queryKey()),
      onError,
    }),
  );
  const isSaving = createShared.isPending || createEnvironment.isPending;
  const close = () => {
    if (!isSaving) resetAndClose();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) close();
      }}
    >
      <DialogContent size="2xl">
        <DialogHeader>
          <DialogTitle>Add Custom Skill</DialogTitle>
          <DialogDescription>
            Create reusable instructions and choose where they are available.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            className="space-y-4"
            onSubmit={form.handleSubmit((values) => {
              if (availability === 'environment') {
                if (environmentIds.length === 0) {
                  toast.error('Select at least one environment.');
                  return;
                }
                createEnvironment.mutate({ ...values, environmentIds });
                return;
              }
              createShared.mutate(values);
            })}
          >
            <div className="space-y-2">
              <Label>Availability</Label>
              <RadioGroup
                value={availability}
                onValueChange={(value) =>
                  setAvailability(value as NewSkillAvailability)
                }
                aria-label="New skill availability"
                className="space-y-2"
              >
                <div className="flex items-center gap-2">
                  <RadioGroupItem
                    value="shared"
                    id="new-skill-shared"
                    disabled={isSaving}
                  />
                  <Label htmlFor="new-skill-shared" className="cursor-pointer">
                    Everywhere
                  </Label>
                </div>
                {isAdmin ? (
                  <div className="flex items-center gap-2">
                    <RadioGroupItem
                      value="environment"
                      id="new-skill-environment"
                      disabled={
                        isSaving ||
                        environments.isPending ||
                        environments.data?.environments.length === 0
                      }
                    />
                    <Label
                      htmlFor="new-skill-environment"
                      className="cursor-pointer"
                    >
                      Only in selected environments
                    </Label>
                  </div>
                ) : null}
              </RadioGroup>
              {availability === 'environment' ? (
                <div className="space-y-2 rounded-md border p-3">
                  {environments.data?.environments.map((environment) => (
                    <label
                      key={environment.id}
                      htmlFor={`new-skill-env-${environment.id}`}
                      className="flex cursor-pointer items-center gap-2 text-sm"
                    >
                      <Checkbox
                        id={`new-skill-env-${environment.id}`}
                        checked={environmentIds.includes(environment.id)}
                        disabled={isSaving}
                        onCheckedChange={() =>
                          setEnvironmentIds((current) =>
                            current.includes(environment.id)
                              ? current.filter((id) => id !== environment.id)
                              : [...current, environment.id],
                          )
                        }
                      />
                      <VectorSquare />
                      {environment.name}
                    </label>
                  ))}
                </div>
              ) : null}
            </div>
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
                    <Textarea {...field} rows={2} maxLength={1024} />
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
                onClick={close}
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

export function SkillsSettingsPage() {
  const { isAdmin } = useAuthorizedUser();
  const [isCreating, setIsCreating] = useState(false);
  const [marketplaceOpen, setMarketplaceOpen] = useState(false);
  const [filter, setFilter] = useState<SkillListFilter>('all');
  const [search, setSearch] = useState('');

  return (
    <SettingsShell pageId="skills">
      <div className="space-y-3">
        <SkillListToolbar
          filter={filter}
          search={search}
          showEnvironmentFilter={isAdmin}
          onFilterChange={setFilter}
          onSearchChange={setSearch}
          actions={
            <>
              {isAdmin ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setMarketplaceOpen(true)}
                >
                  <Plus />
                  Add from Marketplace
                </Button>
              ) : null}
              <Button size="sm" onClick={() => setIsCreating(true)}>
                <Plus />
                Add Custom Skill
              </Button>
            </>
          }
        />
        <Card variant="snug">
          <CardContent className="p-0!">
            <div role="table" aria-label="Skills">
              <SkillListHeader />
              <div role="rowgroup" className="divide-y divide-background">
                <InstanceSkills filter={filter} search={search} />
                {isAdmin ? (
                  <CustomSkills
                    filter={filter}
                    search={search}
                    marketplaceOpen={marketplaceOpen}
                    onMarketplaceOpenChange={setMarketplaceOpen}
                  />
                ) : null}
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
      <AddCustomSkillDialog
        open={isCreating}
        isAdmin={isAdmin}
        onOpenChange={setIsCreating}
      />
    </SettingsShell>
  );
}
