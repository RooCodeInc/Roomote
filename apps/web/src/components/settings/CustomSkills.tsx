'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { toast } from 'sonner';

import { useTRPC } from '@/trpc/client';

import {
  ArrowUpFromLine,
  BasicTooltip,
  Button,
  Card,
  CardContent,
  Check,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Pencil,
  Search,
  Skeleton,
  Sparkles,
  Spinner,
  SquareArrowOutUpRight,
  Textarea,
  Trash2,
  VectorSquare,
  X,
} from '@/components/system';
import {
  SkillListRow,
  type SkillListFilter,
} from '@/components/settings/SkillList';

const SEARCH_DEBOUNCE_MS = 300;
const MIN_SEARCH_LENGTH = 2;
const MANUAL_SKILL_TEMPLATE_NAME = 'my-manual-skill';
const MANUAL_SKILL_TEMPLATE_DESCRIPTION = 'Adds custom Roomote behavior.';
const MANUAL_SKILL_TEMPLATE_CONTENT = `# My Manual Skill

Use this skill when you need custom instructions.`;
const MANUAL_SKILL_INVALID_NAME_CHAR_REGEX = /[/\s]+/g;

type SkillKind = 'manual' | 'marketplace';

type ParsedSkillName = {
  fullName: string;
  author: string;
  name: string;
  nameParts: string[];
};

type AvailabilityEditorState = {
  skillId: string;
  source: string;
  name: string;
  isAllSelection: boolean;
  selectedEnvironmentIds: string[];
  immutableEnvironmentIds: string[];
};

type ManualEditorState = {
  previousSkillId?: string;
  name: string;
  description: string;
  content: string;
  selectedEnvironmentIds: string[];
};

type InstalledSkill = {
  kind: SkillKind;
  source: string;
  name: string;
  skillId: string;
  isAllSelection: boolean;
  installsLabel: string | null;
  url: string | null;
  description: string | null;
  content: string | null;
  environments: Array<{ id: string; name: string }>;
  parsed: ParsedSkillName;
};

function normalizeManualSkillNameInput(value: string) {
  return value.replace(MANUAL_SKILL_INVALID_NAME_CHAR_REGEX, '');
}

function areManualEditorStatesEqual(
  left: ManualEditorState | null,
  right: ManualEditorState | null,
) {
  if (!left || !right) {
    return left === right;
  }

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

type SearchSkill = {
  kind: 'marketplace';
  source: string;
  name: string;
  skillId: string;
  isAllSelection: boolean;
  installsLabel: string | null;
  url: string | null;
  description: string | null;
  content: null;
  parsed: ParsedSkillName;
};

function parseSkillName(rawName: string): ParsedSkillName {
  const slashIndex = rawName.indexOf('/');
  if (slashIndex === -1) {
    return {
      fullName: rawName,
      author: '',
      name: rawName,
      nameParts: rawName.split('-'),
    };
  }
  const author = rawName.slice(0, slashIndex);
  const name = rawName.slice(slashIndex + 1);
  return {
    fullName: rawName,
    author,
    name,
    nameParts: name.split('-'),
  };
}

function formatSkillTitle({
  kind,
  parsed,
  source,
  isAllSelection,
}: {
  kind: SkillKind;
  parsed: ParsedSkillName;
  source: string;
  isAllSelection: boolean;
}) {
  if (kind === 'manual') {
    return parsed.nameParts.join(' ');
  }

  if (isAllSelection) {
    return `${source} (all skills)`;
  }

  return parsed.author
    ? `${parsed.author} / ${parsed.nameParts.join(' ')}`
    : parsed.nameParts.join(' ');
}

function formatSkillByline(skill: {
  kind: SkillKind;
  source: string;
  deploymentName: string;
}) {
  if (skill.kind === 'manual') {
    return `by ${skill.deploymentName}`;
  }

  return `by ${skill.source}`;
}

function formatSkillReference(skill: {
  kind: SkillKind;
  source: string;
  parsed: ParsedSkillName;
  isAllSelection: boolean;
}) {
  if (skill.kind === 'manual') {
    return skill.parsed.fullName;
  }

  if (skill.isAllSelection) {
    return `${skill.source} (all skills)`;
  }

  return `${skill.source}@${skill.parsed.fullName}`;
}

function SkillCard({
  title,
  byline,
  description,
  installLabel,
  url,
  environments,
  actions,
}: {
  title: string;
  byline: string;
  description?: string | null;
  installLabel?: string | null;
  url?: string | null;
  environments?: Array<{ id: string; name: string }>;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3 py-3 first:pt-0 last:pb-0">
      <div className="min-w-0 flex-1 space-y-1">
        <p className="break-words text-sm font-semibold">{title}</p>
        {description ? (
          <p className="line-clamp-2 break-words text-sm text-muted-foreground">
            {description}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span className="break-all">{byline}</span>
          {installLabel ? <span>{installLabel}</span> : null}
          {environments?.map((environment) => (
            <span key={environment.id}>{environment.name}</span>
          ))}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {url ? (
          <BasicTooltip content="View on Marketplace">
            <Button asChild size="icon" variant="ghost">
              <a href={url} target="_blank" rel="noreferrer">
                <SquareArrowOutUpRight />
              </a>
            </Button>
          </BasicTooltip>
        ) : null}
        {actions}
      </div>
    </div>
  );
}

function sortEnvironmentIds(
  environmentIds: string[],
  environmentsById: Map<string, { id: string; name: string }>,
) {
  return [...environmentIds].sort((leftId, rightId) => {
    const leftName = environmentsById.get(leftId)?.name ?? leftId;
    const rightName = environmentsById.get(rightId)?.name ?? rightId;
    return leftName.localeCompare(rightName);
  });
}

export function CustomSkills({
  filter = 'all',
  search = '',
  marketplaceOpen = false,
  onMarketplaceOpenChange = () => {},
}: {
  filter?: SkillListFilter;
  search?: string;
  marketplaceOpen?: boolean;
  onMarketplaceOpenChange?: (open: boolean) => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState('');
  const [hasInteractedWithSearch, setHasInteractedWithSearch] = useState(false);
  const [editorState, setEditorState] =
    useState<AvailabilityEditorState | null>(null);
  const [manualEditorState, setManualEditorState] =
    useState<ManualEditorState | null>(null);
  const [initialManualEditorState, setInitialManualEditorState] =
    useState<ManualEditorState | null>(null);
  const [removeConfirmSkillId, setRemoveConfirmSkillId] = useState<
    string | null
  >(null);
  const canRunSearchQuery =
    hasInteractedWithSearch &&
    debouncedSearchQuery.trim().length >= MIN_SEARCH_LENGTH;

  const listQuery = useQuery(trpc.customSkills.list.queryOptions());
  const searchResultsQuery = useQuery(
    trpc.customSkills.search.queryOptions(
      { query: debouncedSearchQuery },
      {
        enabled: canRunSearchQuery,
        placeholderData: keepPreviousData,
        staleTime: 60_000,
      },
    ),
  );
  const setAvailabilityMutation = useMutation(
    trpc.customSkills.setAvailability.mutationOptions({
      onSuccess: () => {
        toast.success('Skill installed.');
        void listQuery.refetch();
      },
      onError: (error) => {
        toast.error(error.message);
      },
    }),
  );
  const saveManualSkillMutation = useMutation(
    trpc.customSkills.saveManual.mutationOptions({
      onSuccess: () => {
        toast.success('Manual skill saved.');
        setManualEditorState(null);
        setInitialManualEditorState(null);
        void listQuery.refetch();
      },
      onError: (error) => {
        toast.error(error.message);
      },
    }),
  );
  const removeMutation = useMutation(
    trpc.customSkills.remove.mutationOptions({
      onSuccess: (_result, variables) => {
        toast.success('Removed skill from all environments.');
        setRemoveConfirmSkillId(null);
        queryClient.setQueryData(
          trpc.customSkills.list.queryKey(),
          (current: typeof listQuery.data) => {
            if (!current) {
              return current;
            }

            return {
              ...current,
              installed: current.installed.filter(
                (skill) => skill.skillId !== variables.skillId,
              ),
            };
          },
        );
        void listQuery.refetch();
      },
      onError: (error) => {
        toast.error(error.message);
      },
    }),
  );

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearchQuery(searchQuery.trim());
    }, SEARCH_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [searchQuery]);

  const environments = useMemo(
    () => listQuery.data?.environments ?? [],
    [listQuery.data?.environments],
  );
  const environmentsById = useMemo(
    () =>
      new Map(environments.map((environment) => [environment.id, environment])),
    [environments],
  );
  const installedSkills = useMemo(
    () =>
      (listQuery.data?.installed ?? []).map((skill) => ({
        ...skill,
        parsed: parseSkillName(skill.name),
      })) as InstalledSkill[],
    [listQuery.data?.installed],
  );
  const deploymentName = listQuery.data?.deploymentName ?? 'this deployment';
  const installedSkillIdSet = useMemo(
    () => new Set(installedSkills.map((skill) => skill.skillId)),
    [installedSkills],
  );
  const installedSkillById = useMemo(
    () => new Map(installedSkills.map((skill) => [skill.skillId, skill])),
    [installedSkills],
  );
  const allSelectionEnvironmentIdsBySource = useMemo(() => {
    const bySource = new Map<string, string[]>();

    for (const skill of installedSkills) {
      if (skill.kind !== 'marketplace' || !skill.isAllSelection) {
        continue;
      }

      bySource.set(
        skill.source,
        skill.environments.map((environment) => environment.id),
      );
    }

    return bySource;
  }, [installedSkills]);
  const removeConfirmSkill = useMemo(
    () =>
      removeConfirmSkillId
        ? installedSkills.find(
            (skill) => skill.skillId === removeConfirmSkillId,
          )
        : undefined,
    [removeConfirmSkillId, installedSkills],
  );
  const searchResults = useMemo(
    () =>
      (searchResultsQuery.data ?? []).map((result) => ({
        ...result,
        parsed: parseSkillName(result.name),
      })) as SearchSkill[],
    [searchResultsQuery.data],
  );
  const normalizedCatalogSearch = search.trim().toLowerCase();
  const visibleInstalledSkills = useMemo(
    () =>
      filter === 'shared'
        ? []
        : installedSkills.filter((skill) =>
            [
              formatSkillTitle(skill),
              skill.description ?? '',
              skill.source,
              ...skill.environments.map((environment) => environment.name),
            ]
              .join(' ')
              .toLowerCase()
              .includes(normalizedCatalogSearch),
          ),
    [filter, installedSkills, normalizedCatalogSearch],
  );

  const isSavingAvailability = setAvailabilityMutation.isPending;
  const isSavingManualSkill = saveManualSkillMutation.isPending;

  const toggleEnvironmentSelection = (environmentId: string) => {
    setEditorState((current) => {
      if (!current) {
        return current;
      }

      if (current.immutableEnvironmentIds.includes(environmentId)) {
        return current;
      }

      const selected = current.selectedEnvironmentIds.includes(environmentId);

      return {
        ...current,
        selectedEnvironmentIds: selected
          ? current.selectedEnvironmentIds.filter((id) => id !== environmentId)
          : sortEnvironmentIds(
              [...current.selectedEnvironmentIds, environmentId],
              environmentsById,
            ),
      };
    });
  };

  const toggleManualEnvironmentSelection = (environmentId: string) => {
    setManualEditorState((current) => {
      if (!current) {
        return current;
      }

      const selected = current.selectedEnvironmentIds.includes(environmentId);

      return {
        ...current,
        selectedEnvironmentIds: selected
          ? current.selectedEnvironmentIds.filter((id) => id !== environmentId)
          : sortEnvironmentIds(
              [...current.selectedEnvironmentIds, environmentId],
              environmentsById,
            ),
      };
    });
  };

  const openAvailabilityEditor = ({
    skillId,
    source,
    name,
    isAllSelection,
    selectedEnvironmentIds,
    immutableEnvironmentIds = [],
  }: {
    skillId: string;
    source: string;
    name: string;
    isAllSelection: boolean;
    selectedEnvironmentIds: string[];
    immutableEnvironmentIds?: string[];
  }) => {
    setEditorState({
      skillId,
      source,
      name,
      isAllSelection,
      selectedEnvironmentIds: sortEnvironmentIds(
        Array.from(
          new Set([...selectedEnvironmentIds, ...immutableEnvironmentIds]),
        ),
        environmentsById,
      ),
      immutableEnvironmentIds: sortEnvironmentIds(
        immutableEnvironmentIds,
        environmentsById,
      ),
    });
  };

  const openManualEditor = (skill?: InstalledSkill) => {
    const nextState = {
      previousSkillId: skill?.skillId,
      name: skill?.name ?? MANUAL_SKILL_TEMPLATE_NAME,
      description: skill?.description ?? MANUAL_SKILL_TEMPLATE_DESCRIPTION,
      content: skill?.content ?? MANUAL_SKILL_TEMPLATE_CONTENT,
      selectedEnvironmentIds: sortEnvironmentIds(
        skill?.environments.map((environment) => environment.id) ?? [],
        environmentsById,
      ),
    };

    setInitialManualEditorState(nextState);
    setManualEditorState(nextState);
  };

  const closeManualEditor = () => {
    if (!manualEditorState || isSavingManualSkill) {
      return;
    }

    const hasUnsavedChanges = !areManualEditorStatesEqual(
      manualEditorState,
      initialManualEditorState,
    );

    if (
      hasUnsavedChanges &&
      !window.confirm('Discard unsaved changes to this custom skill?')
    ) {
      return;
    }

    setManualEditorState(null);
    setInitialManualEditorState(null);
  };

  const saveAvailability = async () => {
    if (!editorState) {
      return;
    }

    if (editorState.selectedEnvironmentIds.length === 0) {
      toast.error('Select at least one environment.');
      return;
    }

    const environmentIds = editorState.selectedEnvironmentIds.filter(
      (environmentId) =>
        !editorState.immutableEnvironmentIds.includes(environmentId),
    );

    if (environmentIds.length === 0) {
      toast.error('Select at least one editable environment.');
      return;
    }

    await setAvailabilityMutation.mutateAsync({
      skillId: editorState.skillId,
      environmentIds,
    });

    setEditorState(null);
  };

  const saveManualSkill = async () => {
    if (!manualEditorState) {
      return;
    }

    if (manualEditorState.selectedEnvironmentIds.length === 0) {
      toast.error('Select at least one environment.');
      return;
    }

    await saveManualSkillMutation.mutateAsync({
      name: manualEditorState.name,
      description: manualEditorState.description,
      content: manualEditorState.content,
      environmentIds: manualEditorState.selectedEnvironmentIds,
      previousSkillId: manualEditorState.previousSkillId,
    });
  };

  if (listQuery.isPending) {
    return filter === 'shared' ? null : (
      <div data-testid="environment-skills-skeleton">
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
    );
  }

  if (listQuery.isError) {
    return filter === 'shared' ? null : (
      <p className="px-4 py-6 text-sm text-destructive">
        Failed to load environment-specific skills.
      </p>
    );
  }

  return (
    <>
      <Dialog
        open={editorState !== null}
        onOpenChange={(open) => {
          if (!open) {
            setEditorState(null);
          }
        }}
      >
        <DialogContent size="sm">
          {editorState && (
            <>
              <DialogHeader>
                <DialogTitle>
                  {installedSkillIdSet.has(editorState.skillId)
                    ? 'Manage Skill'
                    : 'Install Skill'}
                </DialogTitle>
                <DialogDescription>
                  Select the environments where{' '}
                  <span className="font-medium text-foreground">
                    {editorState.isAllSelection
                      ? `${editorState.source} (all skills)`
                      : `${editorState.source}@${editorState.name}`}
                  </span>{' '}
                  should be available.
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-2">
                {environments.map((environment) => {
                  const isImmutable =
                    editorState.immutableEnvironmentIds.includes(
                      environment.id,
                    );

                  return (
                    <label
                      key={environment.id}
                      htmlFor={`custom-skill-env-${environment.id}`}
                      className={`flex items-center gap-2 text-sm ${
                        isImmutable
                          ? 'cursor-default opacity-70'
                          : 'cursor-pointer'
                      }`}
                    >
                      <Checkbox
                        id={`custom-skill-env-${environment.id}`}
                        checked={editorState.selectedEnvironmentIds.includes(
                          environment.id,
                        )}
                        disabled={isImmutable}
                        onCheckedChange={() =>
                          toggleEnvironmentSelection(environment.id)
                        }
                      />
                      <VectorSquare className="size-4" />
                      <span>{environment.name}</span>
                    </label>
                  );
                })}
              </div>

              {!editorState.isAllSelection &&
              editorState.immutableEnvironmentIds.length > 0 ? (
                <p className="text-sm text-muted-foreground">
                  Environments already managed by{' '}
                  <span className="font-medium text-foreground">
                    {editorState.source} (all skills)
                  </span>{' '}
                  are read-only here.
                </p>
              ) : null}

              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setEditorState(null)}
                  disabled={isSavingAvailability}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  onClick={() => void saveAvailability()}
                  disabled={
                    isSavingAvailability ||
                    editorState.selectedEnvironmentIds.filter(
                      (environmentId) =>
                        !editorState.immutableEnvironmentIds.includes(
                          environmentId,
                        ),
                    ).length === 0
                  }
                >
                  {isSavingAvailability
                    ? 'Saving…'
                    : installedSkillIdSet.has(editorState.skillId)
                      ? 'Update'
                      : 'Install'}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        open={manualEditorState !== null}
        onOpenChange={(open) => {
          if (!open) {
            closeManualEditor();
          }
        }}
      >
        <DialogContent size="2xl">
          {manualEditorState && (
            <>
              <DialogHeader>
                <DialogTitle>
                  {manualEditorState.previousSkillId
                    ? 'Edit Skill'
                    : 'Add Skill'}
                </DialogTitle>
                <DialogDescription>
                  Available only in the environments you select below.
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="manual-skill-name">Slug</Label>
                  <Input
                    id="manual-skill-name"
                    aria-label="Manual skill slug"
                    value={manualEditorState.name}
                    onChange={(event) => {
                      const nextName = normalizeManualSkillNameInput(
                        event.currentTarget.value,
                      );

                      setManualEditorState((current) =>
                        current
                          ? {
                              ...current,
                              name: nextName,
                            }
                          : current,
                      );
                    }}
                    placeholder="my-manual-skill"
                    pattern="[^/\\s]+"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="manual-skill-description">Description</Label>
                  <p className="text-sm text-muted-foreground">
                    Tell the agent when to use this skill.
                  </p>
                  <Textarea
                    id="manual-skill-description"
                    aria-label="Manual skill description"
                    value={manualEditorState.description}
                    onChange={(event) => {
                      const nextDescription = event.currentTarget.value;

                      setManualEditorState((current) =>
                        current
                          ? {
                              ...current,
                              description: nextDescription,
                            }
                          : current,
                      );
                    }}
                    rows={2}
                    placeholder="Adds custom Roomote behavior."
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="manual-skill-content">Content</Label>
                  <Textarea
                    id="manual-skill-content"
                    aria-label="Manual skill content"
                    value={manualEditorState.content}
                    onChange={(event) => {
                      const nextContent = event.currentTarget.value;

                      setManualEditorState((current) =>
                        current
                          ? {
                              ...current,
                              content: nextContent,
                            }
                          : current,
                      );
                    }}
                    rows={22}
                    spellCheck={false}
                    className="font-mono text-xs"
                  />
                </div>

                <div className="space-y-2  text-sm">
                  <p>Enable in</p>
                  {environments.map((environment) => (
                    <label
                      key={environment.id}
                      htmlFor={`manual-skill-env-${environment.id}`}
                      className="flex cursor-pointer items-center gap-2"
                    >
                      <Checkbox
                        id={`manual-skill-env-${environment.id}`}
                        checked={manualEditorState.selectedEnvironmentIds.includes(
                          environment.id,
                        )}
                        onCheckedChange={() =>
                          toggleManualEnvironmentSelection(environment.id)
                        }
                      />
                      <VectorSquare className="size-4" />
                      <span>{environment.name}</span>
                    </label>
                  ))}
                </div>
              </div>

              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={closeManualEditor}
                  disabled={isSavingManualSkill}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  onClick={() => void saveManualSkill()}
                  disabled={
                    isSavingManualSkill ||
                    manualEditorState.name.trim().length === 0 ||
                    manualEditorState.description.trim().length === 0 ||
                    manualEditorState.content.trim().length === 0 ||
                    manualEditorState.selectedEnvironmentIds.length === 0
                  }
                >
                  {isSavingManualSkill ? <Spinner /> : <Check />}
                  {isSavingManualSkill ? 'Saving…' : 'Save Skill'}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        open={removeConfirmSkillId !== null}
        onOpenChange={(open) => {
          if (!open && !removeMutation.isPending) {
            setRemoveConfirmSkillId(null);
          }
        }}
      >
        <DialogContent size="sm">
          {removeConfirmSkill && (
            <>
              <DialogHeader>
                <DialogTitle>Uninstall Skill</DialogTitle>
                <DialogDescription>
                  This will remove{' '}
                  <span className="font-medium text-foreground">
                    {formatSkillReference(removeConfirmSkill)}
                  </span>{' '}
                  {removeConfirmSkill.kind === 'manual'
                    ? 'from the environments currently using this manual skill variant.'
                    : 'from all environments.'}{' '}
                  This action cannot be undone.
                </DialogDescription>
              </DialogHeader>

              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setRemoveConfirmSkillId(null)}
                  disabled={removeMutation.isPending}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  onClick={() =>
                    removeMutation.mutate({
                      skillId: removeConfirmSkill.skillId,
                    })
                  }
                  disabled={removeMutation.isPending}
                >
                  {removeMutation.isPending ? (
                    <>
                      <Spinner className="size-4" />
                      Removing…
                    </>
                  ) : (
                    'Uninstall'
                  )}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {visibleInstalledSkills.length === 0 ? (
        filter === 'environment' ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">
            {normalizedCatalogSearch
              ? 'No environment-specific skills match your search.'
              : environments.length === 0
                ? 'No environments are available. Create an environment before adding an environment-specific skill.'
                : 'No environment-specific skills yet. Add a custom skill or install one from the marketplace.'}
          </p>
        ) : null
      ) : (
        visibleInstalledSkills.map((skill) => (
          <SkillListRow
            key={skill.skillId}
            icon={Sparkles}
            name={formatSkillTitle(skill)}
            summary={formatSkillByline({
              kind: skill.kind,
              source: skill.source,
              deploymentName,
            })}
            description={
              <p className="line-clamp-2 break-words">
                {skill.description ?? 'No description provided.'}
              </p>
            }
            availability={
              <span className="flex flex-wrap items-center gap-x-1 gap-y-1">
                <span>Only in</span>
                {skill.environments.map((environment, index) => (
                  <span
                    key={environment.id}
                    className="inline-flex items-center gap-1"
                  >
                    <VectorSquare className="size-3.5" />
                    {environment.name}
                    {index < skill.environments.length - 1 ? ',' : null}
                  </span>
                ))}
              </span>
            }
            actions={
              <>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  aria-label={`Edit ${formatSkillReference(skill)}`}
                  onClick={() =>
                    skill.kind === 'manual'
                      ? openManualEditor(skill)
                      : openAvailabilityEditor({
                          skillId: skill.skillId,
                          source: skill.source,
                          name: skill.parsed.fullName,
                          isAllSelection: skill.isAllSelection,
                          selectedEnvironmentIds: skill.environments.map(
                            (environment) => environment.id,
                          ),
                          immutableEnvironmentIds: skill.isAllSelection
                            ? []
                            : (allSelectionEnvironmentIdsBySource.get(
                                skill.source,
                              ) ?? []),
                        })
                  }
                >
                  <Pencil />
                </Button>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  aria-label={`Remove ${formatSkillReference(skill)}`}
                  onClick={() => setRemoveConfirmSkillId(skill.skillId)}
                >
                  <Trash2 />
                </Button>
              </>
            }
          />
        ))
      )}

      <Dialog open={marketplaceOpen} onOpenChange={onMarketplaceOpenChange}>
        <DialogContent size="2xl">
          <DialogHeader>
            <DialogTitle>Add from Marketplace</DialogTitle>
            <DialogDescription>
              Search the{' '}
              <Link
                href="https://skills.sh"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                Vercel Marketplace
                <SquareArrowOutUpRight className="ml-1 inline size-3" />
              </Link>{' '}
              and choose the environments where a skill should be available.
            </DialogDescription>
          </DialogHeader>

          {environments.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No environments are available. Create an environment before
              installing a marketplace skill.
            </p>
          ) : (
            <div className="space-y-3">
              <div className="flex w-full items-center gap-2">
                <div className="relative w-full md:max-w-md">
                  <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="custom-skills-search"
                    value={searchQuery}
                    onChange={(event) => {
                      setHasInteractedWithSearch(true);
                      setSearchQuery(event.currentTarget.value);
                    }}
                    placeholder="Search by skill name or source"
                    className="pl-9"
                  />
                  {searchResultsQuery.isFetching && canRunSearchQuery ? (
                    <Spinner className="absolute right-3 top-1/2 -translate-y-1/2" />
                  ) : (
                    searchQuery && (
                      <button
                        type="button"
                        onClick={() => {
                          setSearchQuery('');
                          setDebouncedSearchQuery('');
                          queryClient.removeQueries({
                            queryKey: trpc.customSkills.search.queryKey(),
                          });
                        }}
                        className="absolute right-3 top-1/2 -translate-y-1/2 cursor-pointer text-muted-foreground hover:text-foreground"
                        aria-label="Clear search"
                      >
                        <X className="size-4" />
                      </button>
                    )
                  )}
                </div>
              </div>

              {canRunSearchQuery && searchResultsQuery.isError ? (
                <p className="text-sm text-destructive">
                  {searchResultsQuery.error.message}
                </p>
              ) : null}

              {canRunSearchQuery && searchResultsQuery.data ? (
                searchResults.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No skills found for this search.
                  </p>
                ) : (
                  <Card variant="snug">
                    <CardContent>
                      <div className="divide-y divide-background">
                        {searchResults.map((result) => {
                          const installedSkill = installedSkillById.get(
                            result.skillId,
                          );
                          const sourceAllEnvironmentIds =
                            allSelectionEnvironmentIdsBySource.get(
                              result.source,
                            ) ?? [];
                          const explicitEnvironmentIds =
                            installedSkill?.environments.map(
                              (environment) => environment.id,
                            ) ?? [];
                          const editableEnvironmentIds = environments
                            .map((environment) => environment.id)
                            .filter(
                              (environmentId) =>
                                !sourceAllEnvironmentIds.includes(
                                  environmentId,
                                ),
                            );
                          const isCoveredByAllSelection =
                            sourceAllEnvironmentIds.length > 0 &&
                            editableEnvironmentIds.length === 0;
                          const isInstalled =
                            installedSkillIdSet.has(result.skillId) ||
                            isCoveredByAllSelection;
                          const canInstall =
                            !isInstalled && editableEnvironmentIds.length > 0;
                          const selectedEnvironmentIds = installedSkill
                            ? Array.from(
                                new Set([
                                  ...explicitEnvironmentIds,
                                  ...sourceAllEnvironmentIds,
                                ]),
                              )
                            : sourceAllEnvironmentIds;

                          return (
                            <SkillCard
                              key={result.skillId}
                              title={formatSkillTitle(result)}
                              byline={formatSkillByline({
                                kind: result.kind,
                                source: result.source,
                                deploymentName,
                              })}
                              description={result.description}
                              installLabel={result.installsLabel}
                              url={result.url}
                              actions={
                                <Button
                                  type="button"
                                  size="sm"
                                  disabled={!canInstall}
                                  onClick={() => {
                                    onMarketplaceOpenChange(false);
                                    openAvailabilityEditor({
                                      skillId: result.skillId,
                                      source: result.source,
                                      name: result.parsed.fullName,
                                      isAllSelection: result.isAllSelection,
                                      selectedEnvironmentIds,
                                      immutableEnvironmentIds:
                                        sourceAllEnvironmentIds,
                                    });
                                  }}
                                >
                                  {isInstalled || !canInstall ? (
                                    <Check />
                                  ) : (
                                    <ArrowUpFromLine />
                                  )}
                                  {isInstalled
                                    ? 'Installed'
                                    : canInstall
                                      ? 'Install'
                                      : 'Available'}
                                </Button>
                              }
                            />
                          );
                        })}
                      </div>
                    </CardContent>
                  </Card>
                )
              ) : null}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
