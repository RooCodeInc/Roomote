'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';

import { useTelemetry } from '@/hooks/useTelemetry';

// Don't ask for a suggestion until the conversation has some substance.
export const SUGGESTION_MIN_HISTORY_MESSAGES = 2;

/**
 * Ghost-text composer suggestion behavior shared by the task and session
 * composers: renders only while the composer is empty and idle, Tab accepts,
 * Escape dismisses, and a send consumes the suggestion so the cached value
 * cannot reappear in the emptied composer.
 */
export function useGhostSuggestion({
  suggestion,
  active,
  surface,
  onAccept,
}: {
  /** Latest suggestion from the query, or null. */
  suggestion: string | null;
  /** Whether the composer is empty and idle (ghost text may render). */
  active: boolean;
  surface: 'task' | 'session';
  /** Insert the accepted suggestion into the composer. */
  onAccept: (text: string) => void;
}) {
  const { capture } = useTelemetry();
  const [dismissedSuggestion, setDismissedSuggestion] = useState<string | null>(
    null,
  );
  const suggestionHintId = useId();

  // Ghost text renders only in a truly empty, idle composer.
  const ghostSuggestion =
    suggestion && suggestion !== dismissedSuggestion && active
      ? suggestion
      : null;

  const acceptGhostSuggestion = useCallback(() => {
    if (!ghostSuggestion) {
      return;
    }

    onAccept(ghostSuggestion);
    capture('composer_suggestion_accepted', { surface });
  }, [ghostSuggestion, onAccept, capture, surface]);

  const dismissGhostSuggestion = useCallback(() => {
    if (!ghostSuggestion) {
      return;
    }

    setDismissedSuggestion(ghostSuggestion);
    capture('composer_suggestion_dismissed', { surface });
  }, [ghostSuggestion, capture, surface]);

  // A send consumes the current suggestion: the history bucket may not
  // advance for several messages, so without this the cached suggestion
  // reappears in the emptied composer.
  const consumeSuggestion = useCallback(() => {
    if (suggestion) {
      setDismissedSuggestion(suggestion);
    }
  }, [suggestion]);

  /** Returns true when the key event was handled (Tab accept / Esc dismiss). */
  const handleSuggestionKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!ghostSuggestion || event.nativeEvent.isComposing) {
        return false;
      }

      if (
        event.key === 'Tab' &&
        !event.shiftKey &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey
      ) {
        event.preventDefault();
        acceptGhostSuggestion();
        return true;
      }

      if (event.key === 'Escape') {
        event.preventDefault();
        dismissGhostSuggestion();
        return true;
      }

      return false;
    },
    [ghostSuggestion, acceptGhostSuggestion, dismissGhostSuggestion],
  );

  // Count each distinct rendered suggestion once.
  const lastShownSuggestionRef = useRef<string | null>(null);
  useEffect(() => {
    if (ghostSuggestion && lastShownSuggestionRef.current !== ghostSuggestion) {
      lastShownSuggestionRef.current = ghostSuggestion;
      capture('composer_suggestion_shown', { surface });
    }
  }, [ghostSuggestion, capture, surface]);

  return {
    ghostSuggestion,
    suggestionHintId,
    acceptGhostSuggestion,
    dismissGhostSuggestion,
    consumeSuggestion,
    handleSuggestionKeyDown,
  };
}
