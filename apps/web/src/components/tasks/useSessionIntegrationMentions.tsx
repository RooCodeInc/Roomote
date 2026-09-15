'use client';

import {
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import { useQuery } from '@tanstack/react-query';

import { AtSignIcon } from '@/components/system';
import { useTRPCClient } from '@/trpc/client';

type IntegrationMentionOption = {
  id: string;
  name: string;
  description: string;
};

type ActiveMention = {
  start: number;
  query: string;
};

const MAX_VISIBLE_INTEGRATION_MENTIONS = 8;

function findActiveMention(
  value: string,
  cursor: number,
): ActiveMention | null {
  const beforeCursor = value.slice(0, cursor);
  const match = /(?:^|\s)@([^\s@]*)$/u.exec(beforeCursor);
  if (!match) return null;

  return {
    start: beforeCursor.lastIndexOf('@'),
    query: match[1] ?? '',
  };
}

function integrationMentionText(integration: IntegrationMentionOption): string {
  return `@${integration.name}`;
}

function hasIntegrationMention(
  value: string,
  integration: IntegrationMentionOption,
): boolean {
  const escapedName = integration.name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`(?:^|\\s)@${escapedName}(?=$|\\s|[.,!?;:])`, 'u').test(
    value,
  );
}

export function useSessionIntegrationMentions({
  enabled = true,
  sessionId,
  value,
  onValueChange,
  textareaRef,
}: {
  enabled?: boolean;
  sessionId?: string;
  value: string;
  onValueChange: (value: string) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const trpcClient = useTRPCClient();
  const listboxId = useId();
  const [cursor, setCursor] = useState(value.length);
  const [focused, setFocused] = useState(false);
  const [dismissedMention, setDismissedMention] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const selectedRef = useRef<IntegrationMentionOption[]>([]);
  const activeMention =
    enabled && focused ? findActiveMention(value, cursor) : null;
  const mentionKey = activeMention
    ? `${activeMention.start}:${activeMention.query}`
    : null;
  const integrationsQuery = useQuery({
    queryKey: ['fastSessions.integrationMentions', sessionId ?? null],
    queryFn: () =>
      trpcClient.fastSessions.integrationMentions.query(
        sessionId ? { sessionId } : {},
      ),
    enabled: Boolean(activeMention),
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
  const normalizedQuery = activeMention?.query.toLocaleLowerCase() ?? '';
  const options = (integrationsQuery.data?.integrations ?? [])
    .filter((integration) => {
      const name = integration.name.toLocaleLowerCase();
      return (
        name.includes(normalizedQuery) ||
        integration.id.toLocaleLowerCase().includes(normalizedQuery)
      );
    })
    .slice(0, MAX_VISIBLE_INTEGRATION_MENTIONS);
  const selectedIndex = Math.min(activeIndex, Math.max(0, options.length - 1));
  const open = Boolean(activeMention && mentionKey !== dismissedMention);

  const selectIntegration = (integration: IntegrationMentionOption) => {
    if (!activeMention) return;
    const mention = `${integrationMentionText(integration)} `;
    const nextValue =
      value.slice(0, activeMention.start) + mention + value.slice(cursor);
    const nextCursor = activeMention.start + mention.length;
    const selected = selectedRef.current;
    const nextSelected = selected.some((entry) => entry.id === integration.id)
      ? selected
      : [...selected, integration];

    onValueChange(nextValue);
    selectedRef.current = nextSelected;
    setCursor(nextCursor);
    setDismissedMention(null);
    setActiveIndex(0);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(nextCursor, nextCursor);
    });
  };

  const handleKeyDown = (
    event: KeyboardEvent<HTMLTextAreaElement>,
  ): boolean => {
    if (!open) return false;

    if (event.key === 'Escape') {
      event.preventDefault();
      setDismissedMention(mentionKey);
      return true;
    }
    if (options.length === 0) return false;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      setActiveIndex(
        (selectedIndex + direction + options.length) % options.length,
      );
      return true;
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      selectIntegration(options[selectedIndex]!);
      return true;
    }
    return false;
  };

  const handleValueChange = (nextValue: string, nextCursor: number | null) => {
    const nextSelected = selectedRef.current.filter((integration) =>
      hasIntegrationMention(nextValue, integration),
    );
    onValueChange(nextValue);
    if (nextSelected.length !== selectedRef.current.length) {
      selectedRef.current = nextSelected;
    }
    setCursor(nextCursor ?? nextValue.length);
    setDismissedMention(null);
    setActiveIndex(0);
  };

  const inputProps = {
    'aria-autocomplete': 'list' as const,
    'aria-controls': open ? listboxId : undefined,
    'aria-expanded': open,
    'aria-activedescendant':
      open && options.length > 0
        ? `${listboxId}-option-${selectedIndex}`
        : undefined,
  };

  const suggestions = open ? (
    <div
      id={listboxId}
      role="listbox"
      aria-label="Available integrations"
      className="max-h-56 overflow-y-auto border-b border-border bg-popover p-1 text-popover-foreground"
    >
      {integrationsQuery.isPending ? (
        <div role="status" className="px-3 py-2 text-sm text-muted-foreground">
          Loading integrations...
        </div>
      ) : integrationsQuery.isError ? (
        <div role="status" className="px-3 py-2 text-sm text-muted-foreground">
          Integrations unavailable
        </div>
      ) : options.length > 0 ? (
        options.map((integration, index) => (
          <button
            key={integration.id}
            id={`${listboxId}-option-${index}`}
            type="button"
            role="option"
            aria-selected={index === selectedIndex}
            className="flex w-full items-start gap-2 rounded-sm px-3 py-2 text-left hover:bg-accent aria-selected:bg-accent"
            onPointerDown={(event) => event.preventDefault()}
            onMouseEnter={() => setActiveIndex(index)}
            onClick={() => selectIntegration(integration)}
          >
            <AtSignIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">
                {integration.name}
              </span>
              <span className="block line-clamp-2 text-xs text-muted-foreground">
                {integration.description}
              </span>
            </span>
          </button>
        ))
      ) : (
        <div className="px-3 py-2 text-sm text-muted-foreground">
          No matching integrations
        </div>
      )}
    </div>
  ) : null;

  return {
    textareaRef,
    getSelectedIntegrationIds: (messageText: string) =>
      selectedRef.current
        .filter((integration) =>
          hasIntegrationMention(messageText, integration),
        )
        .map((integration) => integration.id),
    resetSelectedIntegrations: () => {
      selectedRef.current = [];
    },
    handleFocus: () => setFocused(true),
    handleBlur: () => setFocused(false),
    handleCursorChange: (nextCursor: number | null) =>
      setCursor(nextCursor ?? value.length),
    handleValueChange,
    handleKeyDown,
    inputProps,
    suggestions,
  };
}
