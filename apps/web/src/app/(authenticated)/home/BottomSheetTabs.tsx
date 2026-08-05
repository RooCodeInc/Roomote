'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import {
  BasicTooltip,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  MessageCirclePlus,
  X,
} from '@/components/system';
import { cn } from '@/lib/utils';

import { PullRequestsList } from './PullRequestsList';
import { RecentTasksList } from './RecentTasksList';

type HomeTab = 'recent' | 'pullRequests';

type BottomSheetTabsProps = {
  onExpandedChange?: (expanded: boolean) => void;
};

const FEEDBACK_DISMISSED_STORAGE_KEY = 'roomote-home-feedback-dismissed';
const FEEDBACK_CALENDLY_URL =
  'https://calendly.com/d/ctx9-f7q-6vr/roomote-feedback';
const FEEDBACK_EMAIL_URL =
  'mailto:help@roomote.dev?subject=My%20thoughts%20on%20Roomote%20so%20far';

export function BottomSheetTabs({ onExpandedChange }: BottomSheetTabsProps) {
  const [activeTab, setActiveTab] = useState<HomeTab | null>(null);
  const [renderedTab, setRenderedTab] = useState<HomeTab | null>(null);
  const [panelHeight, setPanelHeight] = useState(0);
  const [isFeedbackPromptVisible, setIsFeedbackPromptVisible] = useState(false);
  const [isFeedbackDialogOpen, setIsFeedbackDialogOpen] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  const isExpanded = activeTab !== null;

  const closeSheet = useCallback(() => {
    setActiveTab(null);
    setPanelHeight(0);
  }, []);

  const onTabClick = useCallback(
    (tab: HomeTab) => {
      if (activeTab === tab) {
        closeSheet();
        return;
      }

      setActiveTab(tab);
      setRenderedTab(tab);
    },
    [activeTab, closeSheet],
  );

  useLayoutEffect(() => {
    if (!renderedTab || activeTab === null) {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      setPanelHeight(contentRef.current?.offsetHeight ?? 0);
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [activeTab, renderedTab]);

  useEffect(() => {
    if (!renderedTab || activeTab === null || !contentRef.current) {
      return;
    }

    const contentElement = contentRef.current;
    const resizeObserver = new ResizeObserver(() => {
      setPanelHeight(contentElement.offsetHeight);
    });

    resizeObserver.observe(contentElement);

    return () => {
      resizeObserver.disconnect();
    };
  }, [activeTab, renderedTab]);

  useEffect(() => {
    onExpandedChange?.(isExpanded);
  }, [isExpanded, onExpandedChange]);

  useEffect(() => {
    setIsFeedbackPromptVisible(
      window.localStorage.getItem(FEEDBACK_DISMISSED_STORAGE_KEY) !== '1',
    );
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.altKey || event.ctrlKey || event.metaKey) {
        return;
      }

      if (event.code === 'KeyT') {
        event.preventDefault();
        onTabClick('recent');
      }

      if (event.code === 'KeyP') {
        event.preventDefault();
        onTabClick('pullRequests');
      }
    };

    window.addEventListener('keydown', onKeyDown);

    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [onTabClick]);

  const dismissFeedbackPrompt = () => {
    window.localStorage.setItem(FEEDBACK_DISMISSED_STORAGE_KEY, '1');
    setIsFeedbackPromptVisible(false);
  };

  return (
    <>
      <div className="mx-auto w-full md:max-w-3xl rounded-t-xl overflow-clip">
        <div className="overflow-hidden">
          <div className="flex divide-x-2 divide-background items-center text-sm font-medium transition-all bg-card">
            <BasicTooltip content="Opt/Alt + T">
              <button
                type="button"
                onClick={() => onTabClick('recent')}
                className={cn(
                  'pl-4 pr-5 py-3 cursor-pointer font-semibold text-left transition-colors',
                  activeTab === 'recent'
                    ? 'bg-foreground text-accent-foreground dark:bg-accent-foreground dark:text-card'
                    : 'text-muted-foreground/80 hover:text-accent-foreground',
                )}
              >
                Recent Tasks
              </button>
            </BasicTooltip>

            <BasicTooltip content="Opt/Alt + P">
              <button
                type="button"
                onClick={() => onTabClick('pullRequests')}
                className={cn(
                  'px-5 py-3 cursor-pointer font-semibold text-left transition-colors',
                  activeTab === 'pullRequests'
                    ? 'bg-foreground text-accent-foreground dark:bg-accent-foreground dark:text-card'
                    : 'text-muted-foreground/80 hover:text-accent-foreground',
                )}
              >
                Recent PRs
              </button>
            </BasicTooltip>

            <div className="ml-auto flex min-w-0 items-center">
              {isFeedbackPromptVisible && !isExpanded ? (
                <div className="hidden min-w-0 items-center gap-2 px-3 text-xs text-muted-foreground md:flex">
                  <MessageCirclePlus className="size-4 shrink-0" />
                  <span className="whitespace-nowrap">
                    We&apos;d love{' '}
                    <button
                      type="button"
                      onClick={() => setIsFeedbackDialogOpen(true)}
                      className="cursor-pointer font-medium text-foreground underline underline-offset-2 hover:text-accent-foreground"
                    >
                      your thoughts on Roomote
                    </button>
                  </span>
                  <button
                    type="button"
                    onClick={dismissFeedbackPrompt}
                    aria-label="Dismiss feedback prompt"
                    className="inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md transition-colors hover:bg-accent hover:text-foreground"
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
              ) : null}

              <button
                type="button"
                onClick={closeSheet}
                aria-label="Close bottom sheet"
                className={cn(
                  'relative mr-2 inline-flex size-8 cursor-pointer items-center justify-center rounded-md text-muted-foreground/80 transition-all duration-500 delay-150 hover:text-foreground',
                  isExpanded ? 'top-0 opacity-100' : 'top-6 opacity-0',
                )}
              >
                <X className="size-4" />
              </button>
            </div>
          </div>

          <div
            className="overflow-hidden bg-card border-l border-r border-background transition-[height] duration-500 ease-in-out"
            style={{ height: panelHeight }}
            onTransitionEnd={(event) => {
              if (event.propertyName === 'height' && activeTab === null) {
                setRenderedTab(null);
              }
            }}
          >
            <div
              ref={contentRef}
              className="max-h-56 overflow-y-auto border-t-2 border-background md:max-h-[calc(var(--effective-viewport-height)-26rem)]"
            >
              {renderedTab === 'recent' ? (
                <RecentTasksList enabled={activeTab === 'recent'} />
              ) : renderedTab === 'pullRequests' ? (
                <PullRequestsList enabled={activeTab === 'pullRequests'} />
              ) : null}
            </div>
          </div>
        </div>
      </div>

      <Dialog
        open={isFeedbackDialogOpen}
        onOpenChange={setIsFeedbackDialogOpen}
      >
        <DialogContent size="md">
          <DialogHeader>
            <DialogTitle>Roomote Feedback</DialogTitle>
            <DialogDescription>
              We&apos;d love to hear about your experience so far.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-2 md:grid-cols-2">
            <Button asChild variant="outline">
              <a href={FEEDBACK_CALENDLY_URL} target="_blank" rel="noreferrer">
                Book time with the founders
              </a>
            </Button>
            <Button asChild variant="outline">
              <a href={FEEDBACK_EMAIL_URL}>Write us</a>
            </Button>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setIsFeedbackDialogOpen(false)}
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
