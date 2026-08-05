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
  Calendar,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Mail,
  MessageCirclePlus,
  X,
} from '@/components/system';
import { cn } from '@/lib/utils';

import { PullRequestsList } from './PullRequestsList';
import { RecentTasksList } from './RecentTasksList';
import Image from 'next/image';
import { DiscordLogoIcon } from '@radix-ui/react-icons';

type HomeTab = 'recent' | 'pullRequests';

type BottomSheetTabsProps = {
  onExpandedChange?: (expanded: boolean) => void;
};

const FEEDBACK_DISMISSED_STORAGE_KEY = 'roomote-home-feedback-dismissed';
const FEEDBACK_CALENDLY_URL =
  'https://calendly.com/d/ctx9-f7q-6vr/roomote-feedback';
const FEEDBACK_EMAIL_URL =
  'mailto:help@roomote.dev?subject=My%20thoughts%20on%20Roomote%20so%20far';
const FEEDBACK_DISCORD_URL = 'https://discord.gg/roomote';

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
                  'pl-4 pr-5 py-3 cursor-pointer font-semibold text-left transition-colors text-nowrap',
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
                  'px-5 py-3 cursor-pointer font-semibold text-left transition-colors text-nowrap',
                  activeTab === 'pullRequests'
                    ? 'bg-foreground text-accent-foreground dark:bg-accent-foreground dark:text-card'
                    : 'text-muted-foreground/80 hover:text-accent-foreground',
                )}
              >
                Recent PRs
              </button>
            </BasicTooltip>

            <div className="ml-auto flex min-w-0 items-center">
              {isFeedbackPromptVisible ? (
                <div
                  className={`flex min-w-0  items-center gap-2 px-3 text-sm text-muted-foreground md:flex relative transition-all duration-500 delay-125 -right-10 ${isExpanded ? '-top-6 opacity-0' : 'top-0.5 opacity-100'}`}
                >
                  <button
                    type="button"
                    onClick={() => setIsFeedbackDialogOpen(true)}
                    className="cursor-pointer font-semibold whitespace-nowrap text-muted-foreground/80 hover:text-accent-foreground"
                  >
                    <MessageCirclePlus className="inline -mt-0.5 mx-1.5 size-4 shrink-0" />
                    <span className="hidden md:inline">Feedback, please!</span>
                    <span className="inline md:hidden">Feedback</span>
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
        <DialogContent size="xl">
          <DialogHeader>
            <DialogTitle>What do you think of Roomote so far?</DialogTitle>
            <DialogDescription>
              We&apos;d love to hear about your experience. Anything helps.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-2 my-4 relative">
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
              className="hidden md:block absolute -top-9 right-0 size-44"
            />
          </div>

          <DialogFooter className="md:justify-between">
            <Button
              type="button"
              variant="link"
              size="sm"
              onClick={dismissFeedbackPrompt}
              aria-label="Dismiss feedback prompt"
            >
              Don't show this again
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
