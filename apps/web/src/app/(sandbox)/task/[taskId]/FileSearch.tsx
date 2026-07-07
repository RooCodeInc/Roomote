'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  FileIcon,
  FolderIcon,
  Loader2Icon,
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
  Dialog,
  DialogContent,
  DialogTitle,
} from '@/components/system';

import { useSandboxClient, useSandboxConnected } from './hooks/SandboxProvider';

interface FileSearchProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectFile: (path: string) => void;
}

interface FileResult {
  path: string;
  name: string;
  type: 'file' | 'directory';
}

export const FileSearch = ({
  open,
  onOpenChange,
  onSelectFile,
}: FileSearchProps) => {
  const client = useSandboxClient();
  const connected = useSandboxConnected();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<FileResult[]>([]);
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Reset state when dialog closes
  useEffect(() => {
    if (!open) {
      setQuery('');
      setResults([]);
      setLoading(false);
    }
  }, [open]);

  const search = useCallback(
    async (q: string) => {
      if (!client || !connected || !q.trim()) {
        setResults([]);
        setLoading(false);
        return;
      }

      setLoading(true);

      try {
        const response = await client.commands.searchFiles.query({
          query: q.trim(),
          maxResults: 20,
        });

        setResults(response.results);
      } catch (err) {
        console.error('[FileSearch] searchFiles error:', err);
        setResults([]);
      } finally {
        setLoading(false);
      }
    },
    [client, connected],
  );

  const handleQueryChange = useCallback(
    (value: string) => {
      setQuery(value);

      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }

      if (!value.trim()) {
        setResults([]);
        setLoading(false);
        return;
      }

      setLoading(true);
      debounceRef.current = setTimeout(() => {
        search(value);
      }, 300);
    },
    [search],
  );

  const handleSelect = useCallback(
    (path: string) => {
      onSelectFile(path);
      onOpenChange(false);
    },
    [onSelectFile, onOpenChange],
  );
  const showConnectionMessage = open && (!client || !connected);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="xl"
        className="overflow-hidden p-0"
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">File Search</DialogTitle>
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search files..."
            value={query}
            onValueChange={handleQueryChange}
          />
          <CommandList>
            {showConnectionMessage && (
              <CommandEmpty>Sandbox not connected yet.</CommandEmpty>
            )}
            {loading && results.length === 0 && (
              <div className="flex items-center justify-center py-6">
                <Loader2Icon className="text-muted-foreground size-4 animate-spin" />
              </div>
            )}
            {!showConnectionMessage &&
              !loading &&
              query.trim() &&
              results.length === 0 && (
                <CommandEmpty>No files found.</CommandEmpty>
              )}
            {results.map((file) => {
              const Icon = file.type === 'directory' ? FolderIcon : FileIcon;

              return (
                <CommandItem
                  key={file.path}
                  value={file.path}
                  onSelect={() => handleSelect(file.path)}
                >
                  <Icon className="text-muted-foreground size-4 shrink-0" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-medium">{file.name}</span>
                    <span className="text-muted-foreground truncate text-xs">
                      {file.path}
                    </span>
                  </span>
                </CommandItem>
              );
            })}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
};
