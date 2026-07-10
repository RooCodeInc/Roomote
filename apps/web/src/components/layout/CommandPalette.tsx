'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';

import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  ChartColumnIncreasing,
  GalleryVerticalEnd,
  House,
  Settings,
  HelpCircle,
  Plus,
} from '@/components/system';

import { WorkspaceBadge } from '@/components/sandbox/WorkspaceBadge';
import { formatDistanceToNowCompact } from '@/lib/formatters';
import { SUPPORT_MAILTO } from '@/lib/support';
import { useRecentTasks } from '@/hooks/useRecentTasks';
import { useUser } from '@/hooks/useUser';
import { useTRPC } from '@/trpc/client';
import {
  useCommandPalette,
  type PaletteCommand,
} from './CommandPaletteContext';

const DEFAULT_TASKS_LIMIT = 5;
const SEARCH_TASKS_LIMIT = 15;

type CommandPaletteAutoFocusSignals = {
  anyHoverNone: boolean;
  anyPointerCoarse: boolean;
  maxTouchPoints: number;
};

function shouldDisableCommandPaletteAutoFocus({
  anyHoverNone,
  anyPointerCoarse,
  maxTouchPoints,
}: CommandPaletteAutoFocusSignals) {
  return maxTouchPoints > 0 && anyPointerCoarse && anyHoverNone;
}

function useShouldDisableCommandPaletteAutoFocus() {
  const [shouldDisableAutoFocus, setShouldDisableAutoFocus] = useState(false);

  useEffect(() => {
    const anyPointerCoarseQuery = window.matchMedia('(any-pointer: coarse)');
    const anyHoverNoneQuery = window.matchMedia('(any-hover: none)');

    const update = () => {
      setShouldDisableAutoFocus(
        shouldDisableCommandPaletteAutoFocus({
          anyHoverNone: anyHoverNoneQuery.matches,
          anyPointerCoarse: anyPointerCoarseQuery.matches,
          maxTouchPoints: navigator.maxTouchPoints,
        }),
      );
    };

    update();

    anyPointerCoarseQuery.addEventListener('change', update);
    anyHoverNoneQuery.addEventListener('change', update);

    return () => {
      anyPointerCoarseQuery.removeEventListener('change', update);
      anyHoverNoneQuery.removeEventListener('change', update);
    };
  }, []);

  return shouldDisableAutoFocus;
}

type NavItem =
  | { icon: typeof House; label: string; href: string; action?: undefined }
  | { icon: typeof House; label: string; action: string; href?: undefined };

function AuthorizedCommandPalette() {
  const { open, setOpen, commands } = useCommandPalette();
  const router = useRouter();
  const trpc = useTRPC();
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const { recentTaskIds } = useRecentTasks();
  const shouldDisableAutoFocus = useShouldDisableCommandPaletteAutoFocus();
  const [selectedValue, setSelectedValue] = useState('');
  const hadTasksRef = useRef(false);

  const navItems = useMemo<NavItem[]>(() => {
    const items: NavItem[] = [
      { icon: Plus, label: 'New Task', href: '/' },
      { icon: GalleryVerticalEnd, label: 'Tasks', href: '/tasks' },
      { icon: ChartColumnIncreasing, label: 'Analytics', href: '/analytics' },
      { icon: Settings, label: 'Settings', href: '/settings' },
      { icon: HelpCircle, label: 'Help', action: 'contact-support' },
    ];
    return items;
  }, []);

  // Debounce search input
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
    }, 300);

    return () => clearTimeout(timer);
  }, [search]);

  // Fetch recent tasks (only when dialog is open).
  // Pass recentTaskIds as includeIds so visited tasks always appear even if
  // they aren't in the top N by recent activity (e.g. failed to initialise).
  const { data: tasks } = useQuery(
    trpc.tasks.search.queryOptions(
      {
        query: debouncedSearch || undefined,
        limit: debouncedSearch ? SEARCH_TASKS_LIMIT : DEFAULT_TASKS_LIMIT,
        includeIds: recentTaskIds.length > 0 ? recentTaskIds : undefined,
      },
      { enabled: open },
    ),
  );

  // Promote recently-visited tasks to the top of the list
  const sortedTasks = useMemo(() => {
    if (!tasks || tasks.length === 0) return [];
    const recentSet = new Set(recentTaskIds);
    const visited = recentTaskIds
      .filter((id) => tasks.some((t) => t.id === id))
      .map((id) => tasks.find((t) => t.id === id)!);
    const rest = tasks.filter((t) => !recentSet.has(t.id));
    return [...visited, ...rest];
  }, [tasks, recentTaskIds]);

  // Reset selection to first item when tasks load for the first time
  useEffect(() => {
    if (sortedTasks.length > 0 && !hadTasksRef.current) {
      hadTasksRef.current = true;
      // Reset to empty string so cmdk auto-selects the first item
      setSelectedValue('');
    }
  }, [sortedTasks]);

  // Reset tracking ref when dialog closes
  useEffect(() => {
    if (!open) {
      hadTasksRef.current = false;
    }
  }, [open]);

  // Keyboard shortcut
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setOpen(!open);
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, setOpen]);

  const navigate = useCallback(
    (href: string) => {
      setOpen(false);
      setSearch('');
      router.push(href);
    },
    [setOpen, router],
  );

  // Group dynamic commands by their group label (default: "Actions")
  const commandGroups = useMemo(() => {
    const groups = new Map<string, PaletteCommand[]>();
    for (const cmd of commands) {
      const group = cmd.group ?? 'Actions';
      const existing = groups.get(group);
      if (existing) {
        existing.push(cmd);
      } else {
        groups.set(group, [cmd]);
      }
    }
    return groups;
  }, [commands]);

  return (
    <CommandDialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) setSearch('');
      }}
      value={selectedValue}
      onValueChange={setSelectedValue}
      disableAutoFocus={shouldDisableAutoFocus}
      title="Command Palette"
      description="Navigate to a page or search for a task."
      className="md:min-w-2xl md:min-h-60 md:max-h-120"
    >
      <CommandInput
        placeholder="Search for tasks or type a command..."
        value={search}
        onValueChange={setSearch}
      />
      <CommandList className="scroll-thin">
        <CommandEmpty>No results found.</CommandEmpty>

        {sortedTasks.length > 0 && (
          <>
            <CommandGroup heading="Recent Tasks">
              {sortedTasks
                .slice(
                  0,
                  debouncedSearch ? SEARCH_TASKS_LIMIT : DEFAULT_TASKS_LIMIT,
                )
                .map((task) => (
                  <CommandItem
                    key={task.id}
                    value={`${task.title ?? 'Untitled task'}-${task.id}`}
                    onSelect={() => navigate(`/task/${task.id}`)}
                    className="items-center group"
                  >
                    <span className="truncate">
                      {task.title ?? 'Untitled task'}
                    </span>
                    <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground group-data-[selected=true]:text-foreground transition-colors opacity-70">
                      <WorkspaceBadge
                        environmentId={task.taskRun?.payload?.environmentId}
                        repo={task.taskRun?.payload?.repo ?? undefined}
                        iconClassName="size-3.5!"
                      />
                      <span> · </span>
                      <span>
                        {formatDistanceToNowCompact(
                          new Date(task.timestamp * 1000),
                        )}
                      </span>
                    </span>
                  </CommandItem>
                ))}
            </CommandGroup>
          </>
        )}

        {commandGroups.size > 0 &&
          Array.from(commandGroups.entries()).map(([group, cmds]) => (
            <CommandGroup key={group} heading={group}>
              {cmds.map((cmd) => (
                <CommandItem
                  key={cmd.id}
                  keywords={cmd.keywords}
                  onSelect={() => {
                    setOpen(false);
                    setSearch('');
                    cmd.action();
                  }}
                >
                  <cmd.icon strokeWidth={1.5} />
                  <span>{cmd.label}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          ))}

        <CommandGroup heading="Navigate">
          {navItems.map((item) => (
            <CommandItem
              key={item.href ?? item.action}
              onSelect={() => {
                if (item.href) {
                  navigate(item.href);
                } else if (item.action === 'contact-support') {
                  setOpen(false);
                  setSearch('');
                  window.location.href = SUPPORT_MAILTO;
                }
              }}
            >
              <item.icon />
              <span>{item.label}</span>
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}

export function CommandPalette() {
  const { isSignedIn } = useUser();

  if (!isSignedIn) {
    return null;
  }

  return <AuthorizedCommandPalette />;
}
