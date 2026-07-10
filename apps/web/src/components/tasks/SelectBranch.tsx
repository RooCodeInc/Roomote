import { useState, useRef, useEffect, useMemo, useDeferredValue } from 'react';
import { useFormContext } from 'react-hook-form';
import {
  GitBranch,
  ChevronsUpDown,
  Check,
  Loader2,
  Search,
} from '@/components/system';

import { ALL_REPOSITORIES } from '@roomote/types';

import type { CreateTaskFormValues } from '@/types';

import { cn } from '@/lib/utils';

import { useBranches } from '@/hooks/github';

import {
  FormControl,
  FormField,
  FormMessage,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/system';

const MAX_RENDERED_BRANCHES = 100;

export const SelectBranch = ({
  repositoryFullName,
  defaultBranch,
}: {
  repositoryFullName?: string;
  defaultBranch?: string;
}) => {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const { control, watch, setValue } = useFormContext<CreateTaskFormValues>();

  const formRepository = watch('repository');
  const branch = watch('branch');
  const branchRepository = repositoryFullName ?? formRepository;
  const isAllRepositories = branchRepository === ALL_REPOSITORIES;
  const canFetchBranches = Boolean(branchRepository && !isAllRepositories);
  const branches = useBranches(canFetchBranches ? branchRepository : '');
  const branchSelectionKey = `${branchRepository ?? ''}:${defaultBranch ?? ''}`;

  const previousBranchSelectionKeyRef = useRef(branchSelectionKey);

  // Reset branch when repository changes so it can be re-initialized
  // to the new repository's default branch.
  useEffect(() => {
    if (
      branchRepository &&
      branchSelectionKey !== previousBranchSelectionKeyRef.current
    ) {
      previousBranchSelectionKeyRef.current = branchSelectionKey;
      setValue('branch', '');
    }
  }, [branchRepository, branchSelectionKey, setValue]);

  useEffect(() => {
    const preferredBranch =
      defaultBranch && branches.data?.includes(defaultBranch)
        ? defaultBranch
        : branches.data?.[0];

    if (preferredBranch && (!branch || !branches.data?.includes(branch))) {
      setValue('branch', preferredBranch);
    }
  }, [branches.data, defaultBranch, setValue, branch]);

  // Reset search when menu closes
  useEffect(() => {
    if (!open) {
      setSearch('');
    }
  }, [open]);

  // Focus search input when menu opens
  useEffect(() => {
    if (open) {
      // Small delay to wait for drawer/dropdown animation
      const timer = setTimeout(() => {
        searchInputRef.current?.focus();
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [open]);

  const filteredBranches = useMemo(() => {
    if (!branches.data) return [];
    if (!deferredSearch.trim()) return branches.data;
    const query = deferredSearch.toLowerCase();
    return branches.data.filter((b) => b.toLowerCase().includes(query));
  }, [branches.data, deferredSearch]);

  const visibleBranches = useMemo(() => {
    const cappedBranches = filteredBranches.slice(0, MAX_RENDERED_BRANCHES);

    if (
      !branch ||
      cappedBranches.includes(branch) ||
      !filteredBranches.includes(branch)
    ) {
      return cappedBranches;
    }

    return [branch, ...cappedBranches.slice(0, MAX_RENDERED_BRANCHES - 1)];
  }, [branch, filteredBranches]);

  const isBranchListTruncated =
    filteredBranches.length > visibleBranches.length;

  return (
    <FormField
      control={control}
      name="branch"
      render={({ field }) => (
        <>
          <DropdownMenu open={open} onOpenChange={setOpen}>
            <DropdownMenuTrigger asChild>
              <FormControl>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="w-full max-w-full justify-start border-input bg-card px-3 font-normal hover:bg-card md:w-64 dark:hover:border-input dark:hover:bg-card"
                  disabled={
                    !canFetchBranches ||
                    branches.isPending ||
                    typeof branches.data === 'undefined'
                  }
                >
                  {branches.isLoading ? (
                    <>
                      <Loader2 className="size-4 shrink-0 animate-spin" />
                      <span className="min-w-0 grow truncate text-sm text-left text-muted-foreground">
                        Loading branches...
                      </span>
                    </>
                  ) : (
                    <>
                      <GitBranch className="size-4 shrink-0 text-muted-foreground" />
                      <span
                        className="min-w-0 grow truncate text-left text-sm"
                        title={field.value || undefined}
                      >
                        {field.value || 'Branch'}
                      </span>
                    </>
                  )}
                  <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground opacity-50" />
                </Button>
              </FormControl>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-64">
              <div className="flex items-center gap-2 px-2 py-1.5">
                <Search className="size-4 text-muted-foreground shrink-0" />
                <input
                  ref={searchInputRef}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search branches…"
                  className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                  onKeyDown={(e) => {
                    // Prevent the dropdown from closing on key presses
                    e.stopPropagation();
                  }}
                />
              </div>
              <DropdownMenuSeparator />
              {filteredBranches.length === 0 ? (
                <div className="px-2 py-3 text-center text-sm text-muted-foreground">
                  No branch found.
                </div>
              ) : (
                visibleBranches.map((branchName) => (
                  <DropdownMenuItem
                    key={branchName}
                    onSelect={() => {
                      setValue('branch', branchName);
                      setOpen(false);
                    }}
                  >
                    {branchName}
                    <Check
                      className={cn(
                        'ml-auto size-4',
                        branchName === field.value
                          ? 'opacity-100'
                          : 'opacity-0',
                      )}
                    />
                  </DropdownMenuItem>
                ))
              )}
              {isBranchListTruncated && (
                <>
                  <DropdownMenuSeparator />
                  <div className="px-2 py-2 text-xs text-muted-foreground">
                    Showing {visibleBranches.length.toLocaleString()} of{' '}
                    {filteredBranches.length.toLocaleString()} branches. Refine
                    search for more.
                  </div>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          <FormMessage />
        </>
      )}
    />
  );
};
