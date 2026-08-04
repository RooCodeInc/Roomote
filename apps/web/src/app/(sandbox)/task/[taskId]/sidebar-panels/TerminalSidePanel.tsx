'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import * as TabsPrimitive from '@radix-ui/react-tabs';

import { generateClientUuid } from '@/lib/client-uuid';
import { cn } from '@/lib/utils';
import {
  BasicTooltip,
  Button,
  ChevronDown,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  MoreHorizontal,
  Plus,
  Tabs,
  Terminal,
  Trash2,
  X,
} from '@/components/system';

import { TerminalTab, type TerminalTabHandle } from '../panel/TerminalTab';

import { SidePanelHeader } from './SidePanelHeader';

interface ExtraTerminalTab {
  id: string;
  sessionId: string;
  initialCommand?: string;
}

interface TerminalSidePanelProps {
  active: boolean;
  onClose: () => void;
}

const EXTRA_TERMINAL_PREFIX = 'terminal-';

export function TerminalSidePanel({ active, onClose }: TerminalSidePanelProps) {
  const [activeTab, setActiveTab] = useState<string>('terminal');
  const terminalRef = useRef<TerminalTabHandle>(null);
  const extraTerminalRefs = useRef<Record<string, TerminalTabHandle | null>>(
    {},
  );
  const [extraTerminalTabs, setExtraTerminalTabs] = useState<
    ExtraTerminalTab[]
  >([]);
  const tabsListRef = useRef<HTMLDivElement | null>(null);
  const [tabsOverflow, setTabsOverflow] = useState(false);
  const showTabBar = extraTerminalTabs.length > 0;

  const focusTerminalByValue = useCallback((value: string) => {
    requestAnimationFrame(() => {
      if (value === 'terminal') {
        terminalRef.current?.focus();
        return;
      }

      if (value.startsWith(EXTRA_TERMINAL_PREFIX)) {
        const id = value.slice(EXTRA_TERMINAL_PREFIX.length);
        extraTerminalRefs.current[id]?.focus();
      }
    });
  }, []);

  const setExtraTerminalRef = useCallback(
    (id: string) => (instance: TerminalTabHandle | null) => {
      extraTerminalRefs.current[id] = instance;
    },
    [],
  );

  useEffect(() => {
    if (!active || !activeTab.startsWith('terminal')) {
      return;
    }

    focusTerminalByValue(activeTab);
  }, [active, activeTab, focusTerminalByValue]);

  useLayoutEffect(() => {
    if (!showTabBar) {
      setTabsOverflow(false);
      return;
    }

    const el = tabsListRef.current;
    if (!el) {
      return;
    }

    const checkOverflow = () => {
      setTabsOverflow(el.scrollWidth > el.clientWidth);
    };

    checkOverflow();
    const observer = new ResizeObserver(checkOverflow);
    observer.observe(el);

    return () => observer.disconnect();
  }, [extraTerminalTabs, showTabBar]);

  const openTerminalTab = useCallback(
    (options?: { initialCommand?: string }) => {
      const id = generateClientUuid();
      const sessionId = id;

      setExtraTerminalTabs((prev) => [
        ...prev,
        { id, sessionId, initialCommand: options?.initialCommand },
      ]);

      setActiveTab(`terminal-${id}`);
    },
    [],
  );

  const closeExtraTerminalTab = useCallback((id: string) => {
    setExtraTerminalTabs((prev) => prev.filter((tab) => tab.id !== id));
    delete extraTerminalRefs.current[id];

    setActiveTab((current) =>
      current === `${EXTRA_TERMINAL_PREFIX}${id}` ? 'terminal' : current,
    );
  }, []);

  const scrollTabIntoView = useCallback((value: string) => {
    requestAnimationFrame(() => {
      const container = tabsListRef.current;
      const trigger = container?.querySelector<HTMLElement>(
        `[data-tab-value="${CSS.escape(value)}"]`,
      );
      if (!container || !trigger) {
        return;
      }

      const containerRect = container.getBoundingClientRect();
      const triggerRect = trigger.getBoundingClientRect();

      if (triggerRect.left < containerRect.left) {
        container.scrollLeft += triggerRect.left - containerRect.left;
      } else if (triggerRect.right > containerRect.right) {
        container.scrollLeft += triggerRect.right - containerRect.right;
      }
    });
  }, []);

  const handleTabClick = useCallback((value: string) => {
    setActiveTab(value);
  }, []);

  const activeTabLabel = useMemo(() => {
    if (activeTab === 'terminal') {
      return 'Terminal';
    }

    const terminalIndex = extraTerminalTabs.findIndex(
      (tab) => `terminal-${tab.id}` === activeTab,
    );

    return terminalIndex >= 0 ? `Terminal ${terminalIndex + 2}` : 'Terminal';
  }, [activeTab, extraTerminalTabs]);

  const clearActiveTerminal = useCallback(() => {
    if (activeTab === 'terminal') {
      terminalRef.current?.clearScrollback();
      return;
    }

    if (activeTab.startsWith(EXTRA_TERMINAL_PREFIX)) {
      const id = activeTab.slice(EXTRA_TERMINAL_PREFIX.length);
      extraTerminalRefs.current[id]?.clearScrollback();
    }
  }, [activeTab]);

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background">
      <SidePanelHeader
        title="Terminal"
        onClose={onClose}
        actions={
          <BasicTooltip content="Clear terminal">
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              onClick={clearActiveTerminal}
            >
              <Trash2 className="size-4" />
            </Button>
          </BasicTooltip>
        }
        titleAdornment={
          <BasicTooltip content="New terminal">
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              onClick={() => openTerminalTab()}
            >
              <Plus className="size-4" />
            </Button>
          </BasicTooltip>
        }
      />
      <Tabs value={activeTab} className="flex min-h-0 flex-1 flex-col gap-0">
        {showTabBar ? (
          <div className="flex items-center justify-between border-b border-secondary">
            <TabsPrimitive.List
              data-slot="tabs-list"
              className="flex min-w-0 flex-1 text-xs text-muted-foreground md:hidden"
            >
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button className="flex shrink-0 cursor-pointer items-center gap-2 whitespace-nowrap px-4 py-2 text-secondary-foreground hover:bg-secondary/50">
                    <Terminal className="size-3" />
                    <span>{activeTabLabel}</span>
                    <ChevronDown className="size-3" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-56">
                  <DropdownMenuItem onClick={() => handleTabClick('terminal')}>
                    <Terminal className="mr-2 size-3" />
                    <span>Terminal</span>
                  </DropdownMenuItem>
                  {extraTerminalTabs.map((tab, index) => (
                    <DropdownMenuItem
                      key={tab.id}
                      onClick={() => handleTabClick(`terminal-${tab.id}`)}
                    >
                      <Terminal className="mr-2 size-3" />
                      <span>{`Terminal ${index + 2}`}</span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </TabsPrimitive.List>

            <TabsPrimitive.List
              ref={tabsListRef}
              data-slot="tabs-list"
              className="hidden min-w-0 flex-1 overflow-hidden text-xs text-muted-foreground md:flex"
            >
              <TerminalPanelTrigger
                value="terminal"
                active={activeTab === 'terminal'}
                onClick={() => handleTabClick('terminal')}
              >
                <Terminal className="size-3" />
                <span>Terminal</span>
              </TerminalPanelTrigger>
              {extraTerminalTabs.map((tab, index) => (
                <div key={tab.id} className="group relative">
                  <TerminalPanelTrigger
                    value={`terminal-${tab.id}`}
                    active={activeTab === `terminal-${tab.id}`}
                    onClick={() => handleTabClick(`terminal-${tab.id}`)}
                    className="pr-8"
                  >
                    <Terminal className="size-3" />
                    <span>{`Terminal ${index + 2}`}</span>
                  </TerminalPanelTrigger>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={(event) => {
                      event.stopPropagation();
                      closeExtraTerminalTab(tab.id);
                    }}
                    className="absolute top-1/2 right-2 size-5 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    <X className="size-3" />
                  </Button>
                </div>
              ))}
            </TabsPrimitive.List>

            <div className="flex items-center gap-1 px-2">
              {tabsOverflow ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="hidden size-7 shrink-0 md:inline-flex"
                      title="All terminals"
                    >
                      <MoreHorizontal className="size-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-56">
                    <DropdownMenuItem
                      onClick={() => {
                        handleTabClick('terminal');
                        scrollTabIntoView('terminal');
                      }}
                    >
                      <Terminal className="mr-2 size-3" />
                      <span>Terminal</span>
                    </DropdownMenuItem>
                    {extraTerminalTabs.map((tab, index) => (
                      <DropdownMenuItem
                        key={tab.id}
                        onClick={() => {
                          handleTabClick(`terminal-${tab.id}`);
                          scrollTabIntoView(`terminal-${tab.id}`);
                        }}
                      >
                        <Terminal className="mr-2 size-3" />
                        <span>{`Terminal ${index + 2}`}</span>
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
            </div>
          </div>
        ) : null}

        <div className="ph-no-capture flex-1 min-h-0 bg-zinc-800">
          <div
            style={{
              display: activeTab === 'terminal' ? 'block' : 'none',
            }}
            className="h-full"
          >
            <TerminalTab ref={terminalRef} backgroundColor="#27272a" />
          </div>

          {extraTerminalTabs.map((tab) => (
            <div
              key={tab.id}
              style={{
                display: activeTab === `terminal-${tab.id}` ? 'block' : 'none',
              }}
              className="h-full"
            >
              <TerminalTab
                ref={setExtraTerminalRef(tab.id)}
                sessionId={tab.sessionId}
                initialCommand={tab.initialCommand}
                backgroundColor="#27272a"
                onClose={() => closeExtraTerminalTab(tab.id)}
              />
            </div>
          ))}
        </div>
      </Tabs>
    </div>
  );
}

function TerminalPanelTrigger({
  children,
  value,
  active,
  onClick,
  className,
}: {
  value: string;
  children: React.ReactNode;
  active?: boolean;
  onClick?: () => void;
  className?: string;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);

  const handleClick = useCallback(() => {
    onClick?.();
    requestAnimationFrame(() => {
      const trigger = triggerRef.current;
      const container = trigger?.parentElement?.closest<HTMLElement>(
        '[data-slot="tabs-list"]',
      );
      if (!trigger || !container) {
        return;
      }

      const containerRect = container.getBoundingClientRect();
      const triggerRect = trigger.getBoundingClientRect();

      if (triggerRect.left < containerRect.left) {
        container.scrollLeft += triggerRect.left - containerRect.left;
      } else if (triggerRect.right > containerRect.right) {
        container.scrollLeft += triggerRect.right - containerRect.right;
      }
    });
  }, [onClick]);

  return (
    <TabsPrimitive.Trigger
      ref={triggerRef}
      data-slot="tabs-trigger"
      data-tab-value={value}
      value={value}
      onClick={handleClick}
      className={cn(
        'flex shrink-0 cursor-pointer items-center gap-2 whitespace-nowrap px-4 py-2 hover:bg-secondary/50 active:opacity-80',
        active && 'bg-secondary/50 text-secondary-foreground',
        className,
      )}
    >
      {children}
    </TabsPrimitive.Trigger>
  );
}
