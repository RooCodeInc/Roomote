'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import { BasicTooltip, X } from '@/components/system';
import { cn } from '@/lib/utils';

import { PullRequestsList } from './PullRequestsList';
import { RecentTasksList } from './RecentTasksList';

type HomeTab = 'recent' | 'pullRequests';

type BottomSheetTabsProps = {
  onExpandedChange?: (expanded: boolean) => void;
};

export function BottomSheetTabs({ onExpandedChange }: BottomSheetTabsProps) {
  const [activeTab, setActiveTab] = useState<HomeTab | null>(null);
  const [renderedTab, setRenderedTab] = useState<HomeTab | null>(null);
  const [panelHeight, setPanelHeight] = useState(0);
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

  return (
    <div className="mx-auto w-full md:max-w-3xl rounded-t-xl overflow-clip">
      <div className="overflow-hidden">
        <div
          className={cn(
            'flex divide-x-2 divide-background items-center text-sm font-medium transition-all bg-card',
          )}
        >
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

          <button
            type="button"
            onClick={closeSheet}
            aria-label="Close bottom sheet"
            className={cn(
              'relative ml-auto mr-2 inline-flex size-8 cursor-pointer items-center justify-center rounded-md text-muted-foreground/80 transition-all duration-500 delay-150 hover:text-foreground',
              isExpanded ? 'top-0 opacity-100' : 'top-6 opacity-0',
            )}
          >
            <X className="size-4" />
          </button>
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
  );
}
