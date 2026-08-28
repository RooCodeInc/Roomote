'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { useAuthorizedUser } from '@/hooks/useUser';
import {
  BookMarked,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Plus,
  Trash2,
} from '@/components/system';

const STORAGE_KEY_PREFIX = 'roomote-saved-prompts:v1';
const MAX_SAVED_PROMPTS = 8;

type SavedPrompt = {
  id: string;
  text: string;
  savedAt: number;
};

function parseSavedPrompts(raw: string | null): SavedPrompt[] {
  if (!raw) {
    return [];
  }

  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) {
      return [];
    }

    return value
      .filter(
        (entry): entry is SavedPrompt =>
          typeof entry === 'object' &&
          entry !== null &&
          typeof (entry as SavedPrompt).id === 'string' &&
          typeof (entry as SavedPrompt).text === 'string' &&
          typeof (entry as SavedPrompt).savedAt === 'number',
      )
      .slice(0, MAX_SAVED_PROMPTS);
  } catch {
    return [];
  }
}

function getPromptLabel(text: string): string {
  const firstLine =
    text
      .split('\n')
      .find((line) => line.trim())
      ?.trim() ?? text;
  return firstLine.length > 72 ? `${firstLine.slice(0, 69)}...` : firstLine;
}

type PromptLibraryMenuProps = {
  promptText: string;
  onSelectPrompt: (text: string) => void;
};

export function PromptLibraryMenu({
  promptText,
  onSelectPrompt,
}: PromptLibraryMenuProps) {
  const { userId } = useAuthorizedUser();
  const storageKey = `${STORAGE_KEY_PREFIX}:${userId}`;
  const [savedPrompts, setSavedPrompts] = useState<SavedPrompt[]>([]);
  const [loadedStorageKey, setLoadedStorageKey] = useState<string>();

  useEffect(() => {
    try {
      setSavedPrompts(
        parseSavedPrompts(window.localStorage.getItem(storageKey)),
      );
    } catch {
      setSavedPrompts([]);
    }
    setLoadedStorageKey(storageKey);
  }, [storageKey]);

  const persistPrompts = (prompts: SavedPrompt[]) => {
    setSavedPrompts(prompts);
    setLoadedStorageKey(storageKey);
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(prompts));
    } catch {
      // Keep saved prompts available for this session when storage is unavailable.
    }
  };

  const visiblePrompts =
    loadedStorageKey === storageKey
      ? savedPrompts
      : ([] satisfies SavedPrompt[]);
  const trimmedPrompt = promptText.trim();
  const isCurrentPromptSaved = visiblePrompts.some(
    (prompt) => prompt.text === trimmedPrompt,
  );

  const saveCurrentPrompt = () => {
    if (!trimmedPrompt || isCurrentPromptSaved) {
      return;
    }

    const nextPrompts = [
      {
        id: crypto.randomUUID(),
        text: trimmedPrompt,
        savedAt: Date.now(),
      },
      ...visiblePrompts,
    ].slice(0, MAX_SAVED_PROMPTS);

    persistPrompts(nextPrompts);
    toast.success('Prompt saved');
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm">
          <BookMarked />
          Prompts
          {visiblePrompts.length > 0 ? (
            <span className="text-muted-foreground">
              {visiblePrompts.length}
            </span>
          ) : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-80">
        <DropdownMenuItem
          disabled={!trimmedPrompt || isCurrentPromptSaved}
          onSelect={saveCurrentPrompt}
        >
          <Plus />
          {isCurrentPromptSaved
            ? 'Current prompt is saved'
            : 'Save current prompt'}
        </DropdownMenuItem>

        {visiblePrompts.length > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Saved prompts</DropdownMenuLabel>
            {visiblePrompts.map((prompt) => (
              <DropdownMenuItem
                key={prompt.id}
                className="cursor-pointer"
                onSelect={() => onSelectPrompt(prompt.text)}
              >
                <span className="truncate">{getPromptLabel(prompt.text)}</span>
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => persistPrompts([])}
            >
              <Trash2 />
              Clear saved prompts
            </DropdownMenuItem>
          </>
        ) : (
          <p className="px-2 py-3 text-sm text-muted-foreground">
            Save instructions you want to reuse across tasks.
          </p>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
