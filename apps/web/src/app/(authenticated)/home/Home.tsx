'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';

import { cn } from '@/lib/utils';
import { useAuthorizedUser } from '@/hooks/useUser';
import { useHomeComposerSuggestions } from '@/hooks/useHomeComposerSuggestions';
import { useTRPC } from '@/trpc/client';
import { NewTaskForm } from '@/components/tasks/NewTaskForm';

import { OnboardingCard } from './OnboardingCard';
import { BottomSheetTabs } from './BottomSheetTabs';
import { HOME_HEADINGS } from './headings';
import {
  HOME_PROMPT_PLACEHOLDERS,
  normalizeHomePromptPlaceholderIndex,
} from './promptPlaceholders';

const FALLBACK_PROMPT_PLACEHOLDER = 'What do you want to do?';

type HomeProps = {
  initialHeading?: (typeof HOME_HEADINGS)[number];
  initialPlaceholderIndex: number;
};

export function Home({
  initialHeading = HOME_HEADINGS[0],
  initialPlaceholderIndex,
}: HomeProps) {
  const [isExiting, setIsExiting] = useState(false);
  const [isBottomSheetExpanded, setIsBottomSheetExpanded] = useState(false);
  const [isShortViewport, setIsShortViewport] = useState(false);
  const [isPromptFocused, setIsPromptFocused] = useState(false);
  const [placeholderIndex, setPlaceholderIndex] = useState(() =>
    normalizeHomePromptPlaceholderIndex(initialPlaceholderIndex),
  );
  const [textareaMaxHeight, setTextareaMaxHeight] = useState<
    number | undefined
  >(undefined);

  const { brainConfigured } = useAuthorizedUser();
  const {
    enabled: homeComposerSuggestionsEnabled,
    isLoading: homeComposerSuggestionsFlagLoading,
  } = useHomeComposerSuggestions();
  const trpc = useTRPC();
  const suggestionsQuery = useQuery(
    trpc.home.composerSuggestions.queryOptions(undefined, {
      enabled: homeComposerSuggestionsEnabled && brainConfigured === true,
      // Recheck for newly completed memories on a later Home visit without
      // repeatedly invoking the helper model for an unchanged memory revision.
      staleTime: 5 * 60_000,
      refetchOnWindowFocus: false,
    }),
  );
  const isInitialSuggestionsLoading =
    homeComposerSuggestionsEnabled &&
    brainConfigured === true &&
    suggestionsQuery.isPending &&
    suggestionsQuery.data === undefined;
  const generatedSuggestions = homeComposerSuggestionsEnabled
    ? (suggestionsQuery.data?.suggestions ?? [])
    : [];
  const promptPlaceholders =
    generatedSuggestions.length > 0
      ? generatedSuggestions
      : isInitialSuggestionsLoading
        ? []
        : HOME_PROMPT_PLACEHOLDERS;

  const activePromptPlaceholder = promptPlaceholders.length
    ? promptPlaceholders[placeholderIndex % promptPlaceholders.length]
    : undefined;

  const contentColumnRef = useRef<HTMLDivElement>(null);
  const promptCardRef = useRef<HTMLDivElement>(null);
  const hasResolvedPromptAutoFocusRef = useRef(false);

  useEffect(() => {
    if (
      homeComposerSuggestionsFlagLoading ||
      hasResolvedPromptAutoFocusRef.current
    ) {
      return;
    }

    hasResolvedPromptAutoFocusRef.current = true;
    if (homeComposerSuggestionsEnabled) {
      return;
    }

    const textarea = promptCardRef.current?.querySelector('textarea');
    if (
      !textarea ||
      (document.activeElement !== document.body &&
        document.activeElement !== textarea)
    ) {
      return;
    }

    textarea.focus({ preventScroll: true });
  }, [homeComposerSuggestionsEnabled, homeComposerSuggestionsFlagLoading]);

  useEffect(() => {
    setPlaceholderIndex(
      normalizeHomePromptPlaceholderIndex(initialPlaceholderIndex),
    );
  }, [initialPlaceholderIndex]);

  useEffect(() => {
    if (
      (homeComposerSuggestionsEnabled && isPromptFocused) ||
      promptPlaceholders.length <= 1
    ) {
      return;
    }

    const intervalId = window.setInterval(() => {
      setPlaceholderIndex(
        (currentIndex) => (currentIndex + 1) % promptPlaceholders.length,
      );
    }, 10_000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [
    homeComposerSuggestionsEnabled,
    isPromptFocused,
    promptPlaceholders.length,
  ]);

  // Dynamically compute the max textarea height so it can grow to fill the
  // available space without pushing the bottom-sheet tabs off screen.
  useEffect(() => {
    const column = contentColumnRef.current;
    const card = promptCardRef.current;

    if (!column || !card) {
      return;
    }

    const compute = () => {
      const columnHeight = column.clientHeight;

      // Sum the heights of every sibling element in the column except the
      // prompt card itself.
      let siblingsHeight = 0;

      for (const child of column.children) {
        if (child === card) {
          continue;
        }

        siblingsHeight += (child as HTMLElement).offsetHeight;
      }

      // Account for column gap (gap-4 = 16px, md:gap-3 = 12px).
      const style = getComputedStyle(column);
      const gap = parseFloat(style.rowGap || style.gap || '0');
      const gapCount = column.children.length - 1;
      const totalGap = gap * Math.max(0, gapCount);

      // The prompt card has its own chrome around the textarea: the footer
      // bar, padding, and border. Measure it by subtracting the textarea's
      // current height from the card's height.
      const textarea = card.querySelector('textarea');
      const promptChrome = textarea
        ? card.offsetHeight - textarea.offsetHeight
        : 60;

      const available = columnHeight - siblingsHeight - totalGap - promptChrome;

      // Never go below a sensible minimum (min-h-30 = 120px).
      setTextareaMaxHeight(Math.max(120, Math.floor(available)));
    };

    compute();

    const observer = new ResizeObserver(compute);
    observer.observe(column);
    window.addEventListener('resize', compute);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', compute);
    };
  }, []);

  useEffect(() => {
    const mediaQuery = window.matchMedia('(max-height: 80rem)');
    const syncViewportHeight = () => {
      setIsShortViewport(mediaQuery.matches);
    };

    syncViewportHeight();
    mediaQuery.addEventListener('change', syncViewportHeight);

    return () => {
      mediaQuery.removeEventListener('change', syncViewportHeight);
    };
  }, []);

  const handleTaskStarted = useCallback(() => {
    setIsExiting(true);
  }, []);

  const shouldDimMainForm = isBottomSheetExpanded && isShortViewport;

  return (
    <>
      <div className="flex flex-1 md:items-center justify-center h-[calc(var(--effective-viewport-height)-4rem)] md:h-[calc(var(--effective-viewport-height)-1rem)]">
        <div
          className={cn(
            'flex w-full max-w-3xl flex-col justify-center px-4 h-full',
            isExiting && 'animate-[exit-right_500ms_1_forwards]',
          )}
        >
          <div
            ref={contentColumnRef}
            className={cn(
              'flex flex-col gap-4 md:gap-3 justify-start grow flex-1 min-h-0 overflow-y-auto md:overflow-visible md:h-full md:justify-center transition-all duration-500',
              shouldDimMainForm && 'scale-90 blur-[3px] opacity-70',
            )}
          >
            <h1 className="text-2xl tracking-tight font-bold animate-[enter-down_1s_1] pt-10 md:pt-0">
              {initialHeading}
            </h1>

            <NewTaskForm
              onTaskStarted={handleTaskStarted}
              placeholder={
                isInitialSuggestionsLoading
                  ? ''
                  : homeComposerSuggestionsEnabled
                    ? FALLBACK_PROMPT_PLACEHOLDER
                    : activePromptPlaceholder
              }
              promptSuggestion={
                homeComposerSuggestionsEnabled
                  ? activePromptPlaceholder
                  : undefined
              }
              onPromptFocusChange={
                homeComposerSuggestionsEnabled ? setIsPromptFocused : undefined
              }
              autoFocus={false}
              textareaMaxHeight={textareaMaxHeight}
              promptContainerRef={promptCardRef}
            />

            <div className="flex flex-col flex-wrap gap-2 md:flex-row md:flex-nowrap md:items-center animate-[fade-in_1s_1_750ms_backwards]">
              <OnboardingCard />
            </div>
          </div>
          <div className="shrink-0 pb-[env(safe-area-inset-bottom)]">
            <BottomSheetTabs onExpandedChange={setIsBottomSheetExpanded} />
          </div>
        </div>
      </div>
    </>
  );
}
