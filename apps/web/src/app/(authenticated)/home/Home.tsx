'use client';

import Image from 'next/image';
import { useState, useCallback, useEffect, useRef } from 'react';
import { DiscordLogoIcon } from '@radix-ui/react-icons';

import { cn } from '@/lib/utils';
import {
  Button,
  Calendar,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Mail,
  MessageCirclePlus,
} from '@/components/system';
import { NewTaskForm } from '@/components/tasks/NewTaskForm';

import { OnboardingCard } from './OnboardingCard';
import { BottomSheetTabs } from './BottomSheetTabs';
import {
  HOME_PROMPT_PLACEHOLDERS,
  normalizeHomePromptPlaceholderIndex,
} from './promptPlaceholders';

const FALLBACK_PROMPT_PLACEHOLDER = 'What do you want to do?';
const FEEDBACK_DISMISSED_STORAGE_KEY = 'roomote-home-feedback-dismissed';
const FEEDBACK_CALENDLY_URL =
  'https://calendly.com/d/ctx9-f7q-6vr/roomote-feedback';
const FEEDBACK_EMAIL_URL =
  'mailto:help@roomote.dev?subject=My%20thoughts%20on%20Roomote%20so%20far';
const FEEDBACK_DISCORD_URL = 'https://discord.gg/roomote';

function isFeedbackPromptDismissed(): boolean {
  try {
    return window.localStorage.getItem(FEEDBACK_DISMISSED_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function persistFeedbackPromptDismissal(): void {
  try {
    window.localStorage.setItem(FEEDBACK_DISMISSED_STORAGE_KEY, '1');
  } catch {
    // Ignore storage failures; the prompt can still be dismissed for this session.
  }
}

type HomeProps = {
  initialPlaceholderIndex: number;
};

export function Home({ initialPlaceholderIndex }: HomeProps) {
  const [isExiting, setIsExiting] = useState(false);
  const [isBottomSheetExpanded, setIsBottomSheetExpanded] = useState(false);
  const [isFeedbackPromptVisible, setIsFeedbackPromptVisible] = useState(false);
  const [isFeedbackDialogOpen, setIsFeedbackDialogOpen] = useState(false);
  const [isShortViewport, setIsShortViewport] = useState(false);
  const [placeholderIndex, setPlaceholderIndex] = useState(() =>
    normalizeHomePromptPlaceholderIndex(initialPlaceholderIndex),
  );
  const [textareaMaxHeight, setTextareaMaxHeight] = useState<
    number | undefined
  >(undefined);

  const activePromptPlaceholder =
    HOME_PROMPT_PLACEHOLDERS[placeholderIndex] ?? FALLBACK_PROMPT_PLACEHOLDER;

  const contentColumnRef = useRef<HTMLDivElement>(null);
  const promptCardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setIsFeedbackPromptVisible(!isFeedbackPromptDismissed());
  }, []);

  useEffect(() => {
    setPlaceholderIndex(
      normalizeHomePromptPlaceholderIndex(initialPlaceholderIndex),
    );
  }, [initialPlaceholderIndex]);

  useEffect(() => {
    if (HOME_PROMPT_PLACEHOLDERS.length <= 1) {
      return;
    }

    const intervalId = window.setInterval(() => {
      setPlaceholderIndex(
        (currentIndex) => (currentIndex + 1) % HOME_PROMPT_PLACEHOLDERS.length,
      );
    }, 5_000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, []);

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
              New Session
            </h1>

            <NewTaskForm
              onTaskStarted={handleTaskStarted}
              placeholder={activePromptPlaceholder}
              textareaMaxHeight={textareaMaxHeight}
              promptContainerRef={promptCardRef}
            />

            <div className="flex flex-col flex-wrap gap-2 md:flex-row md:flex-nowrap md:items-center animate-[fade-in_1s_1_750ms_backwards]">
              <OnboardingCard />
              {isFeedbackPromptVisible ? (
                <button
                  type="button"
                  onClick={() => setIsFeedbackDialogOpen(true)}
                  className="inline-flex cursor-pointer items-center font-semibold whitespace-nowrap text-sm text-muted-foreground/80 hover:text-accent-foreground md:ml-auto"
                >
                  <MessageCirclePlus className="mr-1.5 size-4 shrink-0" />
                  Feedback, please!
                </button>
              ) : null}
            </div>
          </div>
          <div className="shrink-0 pb-[env(safe-area-inset-bottom)]">
            <BottomSheetTabs onExpandedChange={setIsBottomSheetExpanded} />
          </div>
        </div>
      </div>

      <Dialog
        open={isFeedbackDialogOpen}
        onOpenChange={setIsFeedbackDialogOpen}
      >
        <DialogContent size="xl">
          <DialogHeader>
            <DialogTitle>What do you think of Roomote so far?</DialogTitle>
            <DialogDescription>
              We&apos;d love to hear about your experience. Anything helps.
            </DialogDescription>
          </DialogHeader>

          <div className="relative my-4 flex flex-col gap-2">
            <Button
              asChild
              variant="default"
              className="md:max-w-xs md:justify-start"
            >
              <a href={FEEDBACK_CALENDLY_URL} target="_blank" rel="noreferrer">
                <Calendar className="size-3.5" />
                Schedule time with the team
              </a>
            </Button>
            <Button
              asChild
              variant="default"
              className="md:max-w-xs md:justify-start"
            >
              <a href={FEEDBACK_EMAIL_URL}>
                <Mail className="size-3.5" />
                Email us
              </a>
            </Button>
            <Button
              asChild
              variant="default"
              className="md:max-w-xs md:justify-start"
            >
              <a href={FEEDBACK_DISCORD_URL} target="_blank" rel="noreferrer">
                <DiscordLogoIcon className="size-3.5" />
                Join the discord
              </a>
            </Button>
            <Image
              src="/elements/feedback.png"
              alt=""
              width={150}
              height={150}
              className="absolute -top-9 right-0 hidden size-44 md:block"
            />
          </div>

          <DialogFooter className="md:justify-between">
            <Button
              type="button"
              variant="link"
              size="sm"
              onClick={() => {
                persistFeedbackPromptDismissal();
                setIsFeedbackPromptVisible(false);
              }}
              aria-label="Dismiss feedback prompt"
            >
              Don&apos;t show this again
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
