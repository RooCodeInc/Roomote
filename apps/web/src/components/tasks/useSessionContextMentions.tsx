'use client';

import {
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import { useQuery } from '@tanstack/react-query';

import { AtSignIcon, MessagesSquare } from '@/components/system';
import { useRecentSessions } from '@/hooks/useRecentSessions';
import { useTRPCClient } from '@/trpc/client';

type IntegrationMentionOption = {
  id: string;
  name: string;
  description: string;
};

type SessionMentionOption = {
  id: string;
  title: string;
};

export type SelectedSessionContext =
  | { kind: 'recent'; sessionIds: string[] }
  | { kind: 'session'; sessionId: string };

type MentionOption =
  | { kind: 'integration'; integration: IntegrationMentionOption }
  | { kind: 'recent-sessions'; sessions: SessionMentionOption[] }
  | { kind: 'session'; session: SessionMentionOption };

type ActiveMention = {
  start: number;
  query: string;
};

type SelectedSessionMention = {
  context: SelectedSessionContext;
  text: string;
};

const MAX_RECENT_SESSION_MENTIONS = 10;
const MAX_VISIBLE_INTEGRATION_MENTIONS = 8;

function isQuotedOrCode(value: string, index: number): boolean {
  let quote: 'single' | 'double' | 'inline-code' | 'fenced-code' | null = null;

  for (let cursor = 0; cursor < index; cursor += 1) {
    const character = value[cursor];
    const escaped = cursor > 0 && value[cursor - 1] === '\\';
    if (
      value.startsWith('```', cursor) &&
      quote !== 'single' &&
      quote !== 'double'
    ) {
      quote = quote === 'fenced-code' ? null : 'fenced-code';
      cursor += 2;
      continue;
    }
    if (quote === 'fenced-code') continue;
    if (
      character === '`' &&
      !escaped &&
      quote !== 'single' &&
      quote !== 'double'
    ) {
      quote = quote === 'inline-code' ? null : 'inline-code';
      continue;
    }
    if (quote === 'inline-code') continue;
    if (character === '"' && !escaped && quote !== 'single') {
      quote = quote === 'double' ? null : 'double';
      continue;
    }
    if (character === "'" && !escaped && quote !== 'double') {
      if (quote === 'single') {
        quote = null;
      } else if (cursor === 0 || /[\s([{]/u.test(value[cursor - 1] ?? '')) {
        quote = 'single';
      }
    }
  }

  return quote !== null;
}

function findActiveMention(
  value: string,
  cursor: number,
): ActiveMention | null {
  const beforeCursor = value.slice(0, cursor);
  const match = /(?:^|\s)@([^\s@]*)$/u.exec(beforeCursor);
  if (!match) return null;

  const start = beforeCursor.lastIndexOf('@');
  if (isQuotedOrCode(value, start)) return null;

  return { start, query: match[1] ?? '' };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function findUnquotedMentionRange(
  value: string,
  mentionText: string,
  allowColonBoundary = true,
): { start: number; end: number } | null {
  const punctuation = allowColonBoundary ? '.,!?;:' : '.,!?;';
  const matcher = new RegExp(
    `(?:^|\\s)${escapeRegExp(mentionText)}(?=$|\\s|[${punctuation}])`,
    'gu',
  );
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(value))) {
    const mentionStart = match.index + (match[0].startsWith('@') ? 0 : 1);
    if (!isQuotedOrCode(value, mentionStart)) {
      return { start: mentionStart, end: mentionStart + mentionText.length };
    }
  }
  return null;
}

function hasUnquotedMention(
  value: string,
  mentionText: string,
  allowColonBoundary = true,
): boolean {
  return Boolean(
    findUnquotedMentionRange(value, mentionText, allowColonBoundary),
  );
}

function integrationMentionText(integration: IntegrationMentionOption): string {
  return `@${integration.name}`;
}

function sessionMentionText(session: SessionMentionOption): string {
  return `@Sessions: ${session.title.replace(/\s+/gu, ' ').trim()}`;
}

function optionKey(option: MentionOption): string {
  switch (option.kind) {
    case 'integration':
      return `integration:${option.integration.id}`;
    case 'recent-sessions':
      return 'recent-sessions';
    case 'session':
      return `session:${option.session.id}`;
  }
}

export function useSessionContextMentions({
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
  const { recentSessionIds } = useRecentSessions();
  const listboxId = useId();
  const [cursor, setCursor] = useState(value.length);
  const [focused, setFocused] = useState(false);
  const [dismissedMention, setDismissedMention] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const selectedIntegrationsRef = useRef<IntegrationMentionOption[]>([]);
  const selectedSessionRef = useRef<SelectedSessionMention | null>(null);
  const activeMention =
    enabled && focused ? findActiveMention(value, cursor) : null;
  const mentionKey = activeMention
    ? `${activeMention.start}:${activeMention.query}`
    : null;
  const recentIds = useMemo(
    () => recentSessionIds.slice(0, MAX_RECENT_SESSION_MENTIONS),
    [recentSessionIds],
  );
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
  const sessionsQuery = useQuery({
    queryKey: ['sessions.contextMentions', recentIds],
    queryFn: () =>
      trpcClient.sessions.list.query({
        ids: recentIds,
        limit: MAX_RECENT_SESSION_MENTIONS,
      }),
    enabled: Boolean(activeMention && recentIds.length > 0),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  const recentSessions = useMemo(() => {
    const sessionsById = new Map(
      (sessionsQuery.data?.sessions ?? []).map((session) => [
        session.id,
        { id: session.id, title: session.title },
      ]),
    );
    return recentIds
      .map((id) => sessionsById.get(id))
      .filter((session): session is SessionMentionOption => Boolean(session));
  }, [recentIds, sessionsQuery.data?.sessions]);
  const normalizedQuery = activeMention?.query.toLocaleLowerCase() ?? '';
  const integrationOptions: MentionOption[] = (
    integrationsQuery.data?.integrations ?? []
  )
    .filter((integration) => {
      const name = integration.name.toLocaleLowerCase();
      return (
        name.includes(normalizedQuery) ||
        integration.id.toLocaleLowerCase().includes(normalizedQuery)
      );
    })
    .slice(0, MAX_VISIBLE_INTEGRATION_MENTIONS)
    .map((integration) => ({ kind: 'integration', integration }));
  const showSessions =
    'sessions'.includes(normalizedQuery) ||
    normalizedQuery.startsWith('sessions');
  const sessionOptions: MentionOption[] = showSessions
    ? [
        ...(recentSessions.length > 0
          ? [{ kind: 'recent-sessions' as const, sessions: recentSessions }]
          : []),
        ...recentSessions.map(
          (session): MentionOption => ({ kind: 'session', session }),
        ),
      ]
    : [];
  const options = [...integrationOptions, ...sessionOptions];
  const selectedIndex = Math.min(activeIndex, Math.max(0, options.length - 1));
  const open = Boolean(activeMention && mentionKey !== dismissedMention);

  const selectOption = (option: MentionOption) => {
    if (!activeMention) return;
    let mentionText: string;
    let nextSelectedSession: SelectedSessionMention | null = null;
    if (option.kind === 'integration') {
      mentionText = integrationMentionText(option.integration);
      if (
        !selectedIntegrationsRef.current.some(
          (entry) => entry.id === option.integration.id,
        )
      ) {
        selectedIntegrationsRef.current = [
          ...selectedIntegrationsRef.current,
          option.integration,
        ];
      }
    } else if (option.kind === 'recent-sessions') {
      mentionText = '@Sessions';
      nextSelectedSession = {
        text: mentionText,
        context: {
          kind: 'recent',
          sessionIds: option.sessions.map((session) => session.id),
        },
      };
    } else {
      mentionText = sessionMentionText(option.session);
      nextSelectedSession = {
        text: mentionText,
        context: { kind: 'session', sessionId: option.session.id },
      };
    }

    let sourceValue = value;
    let sourceStart = activeMention.start;
    let sourceCursor = cursor;
    const previousSession = selectedSessionRef.current;
    if (nextSelectedSession) {
      if (previousSession) {
        const previousRange = findUnquotedMentionRange(
          value,
          previousSession.text,
          previousSession.text !== '@Sessions',
        );
        if (
          previousRange &&
          (previousRange.end <= activeMention.start ||
            previousRange.start >= cursor)
        ) {
          let removalStart = previousRange.start;
          let removalEnd = previousRange.end;
          if (value[removalEnd] === ' ') {
            removalEnd += 1;
          } else if (removalStart > 0 && value[removalStart - 1] === ' ') {
            removalStart -= 1;
          }
          sourceValue = value.slice(0, removalStart) + value.slice(removalEnd);
          if (removalEnd <= activeMention.start) {
            const removedLength = removalEnd - removalStart;
            sourceStart -= removedLength;
            sourceCursor -= removedLength;
          }
        }
      }
      selectedSessionRef.current = nextSelectedSession;
    }

    const insertedMention = `${mentionText} `;
    const nextValue =
      sourceValue.slice(0, sourceStart) +
      insertedMention +
      sourceValue.slice(sourceCursor);
    const nextCursor = sourceStart + insertedMention.length;

    onValueChange(nextValue);
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
      selectOption(options[selectedIndex]!);
      return true;
    }
    return false;
  };

  const handleValueChange = (nextValue: string, nextCursor: number | null) => {
    selectedIntegrationsRef.current = selectedIntegrationsRef.current.filter(
      (integration) =>
        hasUnquotedMention(nextValue, integrationMentionText(integration)),
    );
    const selectedSession = selectedSessionRef.current;
    if (
      selectedSession &&
      !hasUnquotedMention(
        nextValue,
        selectedSession.text,
        selectedSession.text !== '@Sessions',
      )
    ) {
      selectedSessionRef.current = null;
    }
    onValueChange(nextValue);
    setCursor(nextCursor ?? nextValue.length);
    setDismissedMention(null);
    setActiveIndex(0);
  };

  const isLoading =
    integrationsQuery.isPending ||
    (recentIds.length > 0 && sessionsQuery.isPending);
  const isError = integrationsQuery.isError || sessionsQuery.isError;
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
      aria-label="Available context"
      className="max-h-64 overflow-y-auto border-b border-border bg-popover p-1 text-popover-foreground"
    >
      {isLoading ? (
        <div role="status" className="px-3 py-2 text-sm text-muted-foreground">
          Loading context...
        </div>
      ) : isError && options.length === 0 ? (
        <div role="status" className="px-3 py-2 text-sm text-muted-foreground">
          Context unavailable
        </div>
      ) : options.length > 0 ? (
        options.map((option, index) => {
          const isIntegration = option.kind === 'integration';
          const isRecent = option.kind === 'recent-sessions';
          const title = isIntegration
            ? option.integration.name
            : isRecent
              ? 'Sessions'
              : option.session.title;
          const description = isIntegration
            ? option.integration.description
            : isRecent
              ? `Share title and ID for ${option.sessions.length} recently visited Session${option.sessions.length === 1 ? '' : 's'}`
              : option.session.id;
          return (
            <button
              key={optionKey(option)}
              id={`${listboxId}-option-${index}`}
              type="button"
              role="option"
              aria-selected={index === selectedIndex}
              className="flex w-full items-start gap-2 rounded-sm px-3 py-2 text-left hover:bg-accent aria-selected:bg-accent"
              onPointerDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => selectOption(option)}
            >
              {isIntegration ? (
                <AtSignIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              ) : (
                <MessagesSquare className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              )}
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">
                  {title}
                </span>
                <span className="block line-clamp-2 text-xs text-muted-foreground">
                  {description}
                </span>
              </span>
            </button>
          );
        })
      ) : (
        <div className="px-3 py-2 text-sm text-muted-foreground">
          No matching context
        </div>
      )}
    </div>
  ) : null;

  return {
    textareaRef,
    getSelectedIntegrationIds: (messageText: string) =>
      selectedIntegrationsRef.current
        .filter((integration) =>
          hasUnquotedMention(messageText, integrationMentionText(integration)),
        )
        .map((integration) => integration.id),
    getSelectedSessionContext: (
      messageText: string,
    ): SelectedSessionContext | undefined => {
      const selected = selectedSessionRef.current;
      return selected &&
        hasUnquotedMention(
          messageText,
          selected.text,
          selected.text !== '@Sessions',
        )
        ? selected.context
        : undefined;
    },
    resetSelectedContext: () => {
      selectedIntegrationsRef.current = [];
      selectedSessionRef.current = null;
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
