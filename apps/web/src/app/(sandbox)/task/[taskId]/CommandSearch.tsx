'use client';

import { useCallback, useMemo, useState } from 'react';

import {
  Command,
  CommandInput,
  CommandItem,
  CommandList,
  Dialog,
  DialogContent,
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
  source: 'global' | 'project' | 'built-in';
}

// Kept in place for runtime slash commands. The sandbox server does not expose
// command discovery yet, so the dialog currently renders an empty state.
const AVAILABLE_COMMANDS: SlashCommand[] = [];

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
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search commands..."
            value={query}
            onValueChange={setQuery}
          />
          <CommandList>
            {filteredCommands.length === 0 ? (
              <div className="text-muted-foreground py-6 px-4 text-center text-sm">
                Slash commands will appear here once runtime command listing is
                implemented.
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
