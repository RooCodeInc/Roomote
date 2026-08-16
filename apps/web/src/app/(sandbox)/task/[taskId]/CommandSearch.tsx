'use client';

import { useCallback, useMemo, useState } from 'react';
import { PACKAGED_SKILL_INVOCATIONS } from '@roomote/cloud-agents';

import {
  Command,
  CommandInput,
  CommandItem,
  CommandList,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/system';

interface CommandSearchProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectCommand: (name: string) => void;
}

interface SlashCommand {
  name: string;
  description?: string;
}

const AVAILABLE_COMMANDS: SlashCommand[] = [
  {
    name: '/fast',
    description: 'Get a quick answer without starting another task',
  },
  {
    name: '/goal',
    description: 'Keep working toward an objective across multiple turns',
  },
  ...PACKAGED_SKILL_INVOCATIONS.map((name) => ({ name: `/${name}` })),
];

export const CommandSearch = ({
  open,
  onOpenChange,
  onSelectCommand,
}: CommandSearchProps) => {
  const [query, setQuery] = useState('');

  const filteredCommands = useMemo(() => {
    if (!query.trim()) {
      return AVAILABLE_COMMANDS;
    }

    const normalizedQuery = query.toLowerCase();

    return AVAILABLE_COMMANDS.filter(
      (command) =>
        command.name.toLowerCase().includes(normalizedQuery) ||
        command.description?.toLowerCase().includes(normalizedQuery),
    );
  }, [query]);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) {
        setQuery('');
      }

      onOpenChange(nextOpen);
    },
    [onOpenChange],
  );

  const handleSelect = useCallback(
    (name: string) => {
      onSelectCommand(name);
      handleOpenChange(false);
    },
    [handleOpenChange, onSelectCommand],
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        size="xl"
        className="overflow-hidden p-0"
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">Commands</DialogTitle>
        <DialogDescription className="sr-only">
          Search for a command to add to your message.
        </DialogDescription>
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search commands..."
            value={query}
            onValueChange={setQuery}
          />
          <CommandList>
            {filteredCommands.length === 0 ? (
              <div className="text-muted-foreground py-6 px-4 text-center text-sm">
                No commands found.
              </div>
            ) : (
              filteredCommands.map((command) => (
                <CommandItem
                  key={command.name}
                  value={command.name}
                  onSelect={() => handleSelect(command.name)}
                >
                  <span className="flex flex-col gap-2 py-1">
                    <span className="truncate font-mono text-[0.8rem]">
                      {command.name}
                    </span>
                    {command.description && (
                      <span className="truncate text-xs opacity-70">
                        {command.description}
                      </span>
                    )}
                  </span>
                </CommandItem>
              ))
            )}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
};
