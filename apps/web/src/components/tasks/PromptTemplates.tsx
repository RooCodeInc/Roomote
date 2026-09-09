'use client';

import { useId, useState } from 'react';
import { z } from 'zod';

import { useAuthorizedUser } from '@/hooks/useUser';
import {
  Button,
  Input,
  Label,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Trash2,
} from '@/components/system';

const librarySchema = z.object({
  version: z.literal(1),
  templates: z
    .array(
      z.object({
        name: z.string().trim().min(1),
        prompt: z.string().refine((value) => value.trim().length > 0),
      }),
    )
    .refine(
      (items) =>
        new Set(items.map((item) => item.name.toLowerCase())).size ===
        items.length,
    ),
});

type Template = z.infer<typeof librarySchema>['templates'][number];
type Props = {
  prompt: string;
  onLoad: (prompt: string) => void;
  disabled?: boolean;
};

export function PromptTemplates(props: Props) {
  const { userId } = useAuthorizedUser();
  return <UserPromptTemplates key={userId} userId={userId} {...props} />;
}

function UserPromptTemplates({
  userId,
  prompt,
  onLoad,
  disabled,
}: Props & { userId: string }) {
  const nameId = useId();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [templates, setTemplates] = useState<Template[]>([]);
  const [error, setError] = useState('');
  const storageKey = `roomote-prompt-templates:v1:${userId}`;

  function readTemplates(): Template[] {
    const raw = localStorage.getItem(storageKey);
    return raw === null ? [] : librarySchema.parse(JSON.parse(raw)).templates;
  }

  function changeOpen(nextOpen: boolean) {
    if (nextOpen) {
      setError('');
      try {
        setTemplates(readTemplates());
      } catch {
        setTemplates([]);
        setError(
          'Could not read templates from this browser. Stored data has not been changed.',
        );
      }
    }
    setOpen(nextOpen);
  }

  function save() {
    if (!name.trim() || !prompt.trim()) {
      setError('Enter a template name and a non-empty prompt.');
      return;
    }
    try {
      // Re-read before each action so another composer cannot overwrite newer entries.
      const current = readTemplates();
      if (
        current.some(
          (item) => item.name.toLowerCase() === name.trim().toLowerCase(),
        )
      ) {
        setTemplates(current);
        setError(
          'That name already exists. Choose another name or delete the existing template first.',
        );
        return;
      }
      const next = [...current, { name: name.trim(), prompt }];
      localStorage.setItem(
        storageKey,
        JSON.stringify({ version: 1, templates: next }),
      );
      setTemplates(next);
      setName('');
      setError('');
    } catch {
      setError(
        'Could not save the template in this browser. Nothing was saved.',
      );
    }
  }

  function select(templateName: string, remove: boolean) {
    try {
      const current = readTemplates();
      if (remove) {
        const next = current.filter((item) => item.name !== templateName);
        localStorage.setItem(
          storageKey,
          JSON.stringify({ version: 1, templates: next }),
        );
        setTemplates(next);
      } else {
        const template = current.find((item) => item.name === templateName);
        setTemplates(current);
        if (!template) {
          setError('This template no longer exists in this browser.');
          return;
        }
        onLoad(template.prompt);
        setOpen(false);
      }
      setError('');
    } catch {
      setError(
        remove
          ? 'Could not delete the template in this browser. Nothing was deleted.'
          : 'Could not load the template from this browser.',
      );
    }
  }

  return (
    <Popover open={open} onOpenChange={changeOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled}
          className="text-muted-foreground h-8 px-2 text-xs font-normal"
        >
          Templates
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-80 max-w-[calc(100vw-2rem)] space-y-3"
      >
        <div className="space-y-1">
          <h3 className="text-sm font-medium">Prompt templates</h3>
          <p className="text-muted-foreground text-xs">
            Saved only in this browser for your account. Text only, not
            attachments or settings.
          </p>
          <p className="text-muted-foreground text-xs">
            Load replaces the current text for review and editing. Send when
            ready.
          </p>
        </div>
        <div className="max-h-60 space-y-1 overflow-y-auto">
          {templates.length === 0 && (
            <p className="text-muted-foreground text-sm">No saved templates.</p>
          )}
          {templates.map((template) => (
            <div key={template.name} className="flex items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                className="min-w-0 flex-1 justify-start"
                disabled={disabled}
                onClick={() => select(template.name, false)}
                aria-label={`Load ${template.name}`}
              >
                <span className="truncate">{template.name}</span>
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                disabled={disabled}
                aria-label={`Delete ${template.name}`}
                onClick={() => select(template.name, true)}
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          ))}
        </div>
        <div className="space-y-2 border-t pt-3">
          <Label htmlFor={nameId}>Template name</Label>
          <Input
            id={nameId}
            value={name}
            disabled={disabled}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                event.stopPropagation();
                save();
              }
            }}
          />
          <Button type="button" size="sm" disabled={disabled} onClick={save}>
            Save current prompt
          </Button>
        </div>
        {error && (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
