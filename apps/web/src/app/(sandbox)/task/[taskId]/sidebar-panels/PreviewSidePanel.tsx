'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';

import { appendInitialPath, getPrimaryPortName } from '@roomote/types';
import type { TaskRun } from '@roomote/db';

import {
  ArrowLeft,
  ArrowRight,
  Button,
  ChevronDown,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  ExternalLink,
  Input,
  Lock,
  Loader2,
  RectangleHorizontal,
  RefreshCw,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  DropdownMenuLabel,
} from '@/components/system';

import { buildPreviewIframeUrl } from '../preview-iframe-url';
import { useSandboxClient } from '../hooks/SandboxProvider';
import { usePreviewPane } from '../hooks/use-preview-pane';
import { usePreviewUrls } from '../hooks/use-preview-urls';
import { useTaskSidePanel } from '../hooks/use-task-side-panel';
import { shouldIncludeInPreviewServiceList } from '../preview-port-utils';

import { PreviewSetupState } from './PreviewSetupState';
import { SidePanelHeader } from './SidePanelHeader';

interface PreviewEntry {
  name: string;
  label: string;
  url: string;
  isPrimary: boolean;
}

const KEEPALIVE_TOUCH_THROTTLE_MS = 5_000;
const RETRY_TIMEOUT_MS = 300_000;
const INITIAL_RETRY_DELAY_MS = 2_000;
const MAX_RETRY_DELAY_MS = 10_000;
const MOBILE_WIDTH = 375;
const MOBILE_HEIGHT = 667;

function humanizePortName(portName: string): string {
  return portName
    .toLowerCase()
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function getDisplayPath(previewUrl: string | null): string {
  if (!previewUrl) {
    return '';
  }

  try {
    const parsed = new URL(previewUrl);
    return `${parsed.pathname}${parsed.search}${parsed.hash}`.replace(
      /^\//,
      '',
    );
  } catch {
    return previewUrl.replace(/^https?:\/\/[^/]+\/?/, '');
  }
}

function formatElementContext(context: {
  element: string;
  url?: string;
  path: string;
  nearbyText: string;
  cssClasses: string;
  viewport?: { width: number; height: number };
}): string {
  const lines = [`[Element reference: ${context.element}]`];

  if (context.url) {
    lines.push(`URL: ${context.url}`);
  }

  if (context.viewport) {
    lines.push(
      `Viewport: ${context.viewport.width}x${context.viewport.height}`,
    );
  }

  if (context.path) {
    lines.push(`Path: ${context.path}`);
  }

  if (context.cssClasses) {
    lines.push(`Classes: ${context.cssClasses}`);
  }

  if (context.nearbyText) {
    lines.push(`Context: ${context.nearbyText}`);
  }

  return `====\n${lines.join('\n')}\n====`;
}

export function PreviewSidePanel({
  taskRun,
  onClose,
}: {
  taskRun?: TaskRun;
  onClose: () => void;
}) {
  const {
    previewServiceName,
    previewPath,
    openPreviewView,
    updatePreviewPath,
  } = useTaskSidePanel();
  const {
    previewPaneUrl,
    previewPaneRunId,
    previewPaneServiceName,
    openPreviewPane,
    closePreviewPane,
  } = usePreviewPane();
  const { previewUrls, initialPaths, primaryPortName } = usePreviewUrls(
    taskRun ?? {},
  );
  const client = useSandboxClient();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const urlInputRef = useRef<HTMLInputElement>(null);
  const navigatingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const lastTouchRef = useRef(0);
  const hasInitiallyLoadedRef = useRef(false);
  const retryCountRef = useRef(0);
  const retryStartRef = useRef<number | null>(null);
  const retryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingIframeNavigationUrlRef = useRef<string | null>(null);
  const resizingAxis = useRef<'x' | 'y' | 'xy' | null>(null);
  const resizeStartPos = useRef({ x: 0, y: 0 });
  const resizeStartSize = useRef({ width: 0, height: 0 });

  const [currentUrl, setCurrentUrl] = useState<string | null>(null);
  const [isNavigating, setIsNavigating] = useState(false);
  const [isEditingUrl, setIsEditingUrl] = useState(false);
  const [editUrlValue, setEditUrlValue] = useState('');
  const [isWidgetHidden, setIsWidgetHidden] = useState(false);
  const [isMobileView, setIsMobileView] = useState(false);
  const [mobileSize, setMobileSize] = useState({
    width: MOBILE_WIDTH,
    height: MOBILE_HEIGHT,
  });
  const [isResizing, setIsResizing] = useState(false);

  const resolvedPrimaryPortName = useMemo(
    () =>
      primaryPortName ??
      getPrimaryPortName(
        taskRun?.machineDomain,
        taskRun?.machineDomains,
        undefined,
      ),
    [taskRun?.machineDomain, taskRun?.machineDomains, primaryPortName],
  );

  const serviceEntries = useMemo<PreviewEntry[]>(() => {
    if (!previewUrls) {
      return [];
    }

    return Object.entries(previewUrls)
      .filter(([name]) => shouldIncludeInPreviewServiceList(name))
      .map(([name, url]) => {
        const pathForPort =
          previewServiceName === name && previewPath
            ? previewPath
            : initialPaths?.[name];

        return {
          name,
          label: humanizePortName(name),
          url: appendInitialPath(url, pathForPort),
          isPrimary: name === resolvedPrimaryPortName,
        };
      })
      .sort((left, right) => Number(right.isPrimary) - Number(left.isPrimary));
  }, [
    initialPaths,
    previewPath,
    previewServiceName,
    previewUrls,
    resolvedPrimaryPortName,
  ]);

  const activeEntry = useMemo(() => {
    if (previewPaneServiceName) {
      const byName = serviceEntries.find(
        (entry) => entry.name === previewPaneServiceName,
      );

      if (byName) {
        return byName;
      }
    }

    if (previewServiceName) {
      const byRoute = serviceEntries.find(
        (entry) => entry.name === previewServiceName,
      );

      if (byRoute) {
        return byRoute;
      }
    }

    if (previewPaneUrl) {
      const byUrl = serviceEntries.find(
        (entry) => entry.url === previewPaneUrl,
      );

      if (byUrl) {
        return byUrl;
      }
    }

    return serviceEntries[0] ?? null;
  }, [
    previewPaneServiceName,
    previewPaneUrl,
    previewServiceName,
    serviceEntries,
  ]);

  const effectivePreviewUrl = previewPaneUrl ?? activeEntry?.url ?? null;
  const effectiveRunId = previewPaneRunId ?? taskRun?.id ?? null;
  const iframeSrc =
    effectivePreviewUrl && effectiveRunId
      ? buildPreviewIframeUrl(effectivePreviewUrl, effectiveRunId)
      : null;

  useEffect(() => {
    if (!taskRun || !activeEntry) {
      return;
    }

    const hasMatchingPreviewSelection =
      previewPaneRunId === taskRun.id &&
      (previewPaneServiceName
        ? previewPaneServiceName === activeEntry.name
        : previewPaneUrl === activeEntry.url);

    if (hasMatchingPreviewSelection) {
      const pendingIframeNavigationUrl = pendingIframeNavigationUrlRef.current;

      if (pendingIframeNavigationUrl) {
        if (activeEntry.url === pendingIframeNavigationUrl) {
          pendingIframeNavigationUrlRef.current = null;
          return;
        }

        if (previewPaneUrl === activeEntry.url) {
          return;
        }
      }
    }

    if (
      hasMatchingPreviewSelection &&
      (currentUrl ?? previewPaneUrl) === activeEntry.url
    ) {
      return;
    }

    openPreviewPane(activeEntry.url, taskRun.id, activeEntry.name);
  }, [
    activeEntry,
    taskRun,
    currentUrl,
    openPreviewPane,
    previewPaneRunId,
    previewPaneServiceName,
    previewPaneUrl,
  ]);

  const beginNavigationRequest = useCallback(() => {
    setIsNavigating(true);

    if (navigatingTimeoutRef.current) {
      clearTimeout(navigatingTimeoutRef.current);
    }

    navigatingTimeoutRef.current = setTimeout(
      () => setIsNavigating(false),
      3_000,
    );
  }, []);

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (event.data?.type === 'roomote-element-picked' && event.data.context) {
        window.dispatchEvent(
          new CustomEvent('roomote-element-picked', {
            detail: { text: formatElementContext(event.data.context) },
          }),
        );
        return;
      }

      if (event.data?.type === 'roomote-load-complete') {
        setIsNavigating(false);
        setIsWidgetHidden(false);
        hasInitiallyLoadedRef.current = true;

        if (navigatingTimeoutRef.current) {
          clearTimeout(navigatingTimeoutRef.current);
          navigatingTimeoutRef.current = null;
        }

        if (retryTimeoutRef.current) {
          clearTimeout(retryTimeoutRef.current);
          retryTimeoutRef.current = null;
        }

        return;
      }

      if (event.data?.type === 'roomote-widget-hidden') {
        setIsWidgetHidden(true);
        return;
      }

      if (event.data?.type !== 'roomote-navigation' || !event.data.url) {
        return;
      }

      pendingIframeNavigationUrlRef.current = event.data.url;
      setCurrentUrl(event.data.url);
      beginNavigationRequest();

      try {
        const url = new URL(event.data.url);
        updatePreviewPath(`${url.pathname}${url.search}${url.hash}`);
      } catch {
        // Ignore malformed navigation payloads from the preview iframe.
      }

      const now = Date.now();
      if (now - lastTouchRef.current >= KEEPALIVE_TOUCH_THROTTLE_MS) {
        lastTouchRef.current = now;
        client?.commands.touchKeepalive.mutate().catch(() => {
          // Ignore keepalive failures from disconnected sandboxes.
        });
      }
    }

    window.addEventListener('message', handleMessage);

    return () => {
      window.removeEventListener('message', handleMessage);

      if (navigatingTimeoutRef.current) {
        clearTimeout(navigatingTimeoutRef.current);
      }

      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current);
      }
    };
  }, [
    activeEntry?.name,
    beginNavigationRequest,
    client,
    previewServiceName,
    updatePreviewPath,
  ]);

  useEffect(() => {
    setCurrentUrl(null);
    setIsNavigating(false);
    setIsWidgetHidden(false);
    hasInitiallyLoadedRef.current = false;
    pendingIframeNavigationUrlRef.current = null;
    retryCountRef.current = 0;
    retryStartRef.current = null;

    if (retryTimeoutRef.current) {
      clearTimeout(retryTimeoutRef.current);
      retryTimeoutRef.current = null;
    }
  }, [effectiveRunId, effectivePreviewUrl]);

  const handleClose = () => {
    closePreviewPane();
    onClose();
  };

  const handleSelectEntry = (entry: PreviewEntry) => {
    if (!taskRun) {
      return;
    }

    openPreviewPane(entry.url, taskRun.id, entry.name);
    openPreviewView(entry.url, taskRun.id, entry.name);
  };

  const postPreviewNavigation = useCallback(
    (
      type: 'roomote-nav-back' | 'roomote-nav-forward' | 'roomote-nav-reload',
    ) => {
      iframeRef.current?.contentWindow?.postMessage({ type }, '*');
      beginNavigationRequest();
    },
    [beginNavigationRequest],
  );

  const showPreviewWidget = useCallback(() => {
    iframeRef.current?.contentWindow?.postMessage(
      { type: 'roomote-widget-show' },
      '*',
    );
    setIsWidgetHidden(false);
  }, []);

  const toggleMobileView = useCallback(() => {
    setIsMobileView((prev) => !prev);
    setMobileSize({ width: MOBILE_WIDTH, height: MOBILE_HEIGHT });
  }, []);

  const handleResizePointerDown = useCallback(
    (axis: 'x' | 'y' | 'xy') => (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      resizingAxis.current = axis;
      setIsResizing(true);
      resizeStartPos.current = { x: event.clientX, y: event.clientY };
      resizeStartSize.current = { ...mobileSize };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [mobileSize],
  );

  const handleResizePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!resizingAxis.current) {
        return;
      }

      const deltaX = event.clientX - resizeStartPos.current.x;
      const deltaY = event.clientY - resizeStartPos.current.y;
      const axis = resizingAxis.current;

      setMobileSize((prev) => ({
        width:
          axis === 'x' || axis === 'xy'
            ? Math.max(280, resizeStartSize.current.width + deltaX * 2)
            : prev.width,
        height:
          axis === 'y' || axis === 'xy'
            ? Math.max(400, resizeStartSize.current.height + deltaY)
            : prev.height,
      }));
    },
    [],
  );

  const handleResizePointerUp = useCallback(() => {
    resizingAxis.current = null;
    setIsResizing(false);
  }, []);

  const navigateTo = useCallback(
    (path: string) => {
      if (!effectivePreviewUrl) {
        return;
      }

      const trimmedPath = path.trim();
      let targetUrl: string | null = null;

      try {
        const base = new URL(effectivePreviewUrl);
        const parsed = new URL(
          trimmedPath ? `/${trimmedPath.replace(/^\//, '')}` : '/',
          base.origin,
        );

        targetUrl = parsed.toString();
      } catch {
        // Ignore invalid manual edits and leave the current page intact.
      }

      if (!targetUrl) {
        return;
      }

      iframeRef.current?.contentWindow?.postMessage(
        { type: 'roomote-nav-home', url: targetUrl },
        '*',
      );
      pendingIframeNavigationUrlRef.current = targetUrl;
      setCurrentUrl(targetUrl);
      setEditUrlValue(getDisplayPath(targetUrl));
      setIsEditingUrl(false);
      beginNavigationRequest();
    },
    [beginNavigationRequest, effectivePreviewUrl],
  );

  const startEditingUrl = useCallback(() => {
    setIsEditingUrl(true);
    setEditUrlValue(getDisplayPath(currentUrl ?? effectivePreviewUrl));

    requestAnimationFrame(() => {
      urlInputRef.current?.focus();
      urlInputRef.current?.select();
    });
  }, [currentUrl, effectivePreviewUrl]);

  const handleIframeLoad = useCallback(() => {
    iframeRef.current?.contentWindow?.postMessage(
      { type: 'roomote-init', taskUrl: window.location.href },
      '*',
    );

    if (hasInitiallyLoadedRef.current) {
      return;
    }

    if (retryStartRef.current === null) {
      retryStartRef.current = Date.now();
    }

    const elapsed = Date.now() - retryStartRef.current;
    if (elapsed < RETRY_TIMEOUT_MS) {
      const delay = Math.min(
        INITIAL_RETRY_DELAY_MS * Math.pow(1.5, retryCountRef.current),
        MAX_RETRY_DELAY_MS,
      );

      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current);
      }

      retryTimeoutRef.current = setTimeout(() => {
        retryTimeoutRef.current = null;

        if (hasInitiallyLoadedRef.current || !iframeRef.current) {
          return;
        }

        retryCountRef.current += 1;

        try {
          iframeRef.current.contentWindow?.location.reload();
        } catch {
          const src = iframeRef.current.src;
          iframeRef.current.src = '';
          iframeRef.current.src = src;
        }
      }, delay);
    } else {
      hasInitiallyLoadedRef.current = true;
    }
  }, []);

  const activeUrl = currentUrl ?? effectivePreviewUrl;
  const displayUrl = getDisplayPath(activeUrl);

  const titleAdornment = activeEntry ? (
    serviceEntries.length >= 1 ? (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            className="relative -left-2 h-7 gap-1.5 px-2 text-sm font-medium hover:text-accent-foreground"
          >
            <span className="max-w-40 truncate">
              Live Preview: {activeEntry.label}
            </span>
            <ChevronDown className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuLabel>Available Services</DropdownMenuLabel>
          {serviceEntries.map((entry) => (
            <DropdownMenuItem
              key={entry.name}
              onClick={() => handleSelectEntry(entry)}
            >
              {entry.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    ) : (
      <span className="truncate text-muted-foreground text-sm font-semibold">
        Live Preview: {activeEntry.label}
      </span>
    )
  ) : undefined;

  const headerActions = activeEntry ? (
    <>
      <Button
        asChild
        variant="ghost"
        size="icon"
        className="size-8"
        disabled={!activeEntry}
      >
        <a
          aria-label="Open Live Preview in a new tab"
          href={activeEntry?.url ?? undefined}
          rel="noreferrer"
          target="_blank"
        >
          <ExternalLink />
        </a>
      </Button>
    </>
  ) : null;

  const headerTitle = activeEntry ? undefined : 'Live Preview';

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background @container">
      <SidePanelHeader
        title={headerTitle}
        titleAdornment={titleAdornment}
        actions={headerActions}
        onClose={handleClose}
      />

      {iframeSrc ? (
        <div className="flex h-11 items-center gap-2 border-b-2 border-card bg-background px-3">
          <Button
            variant="ghost"
            size="icon"
            className="size-7 shrink-0"
            aria-label="Go back"
            onClick={() => postPreviewNavigation('roomote-nav-back')}
          >
            <ArrowLeft className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 shrink-0"
            aria-label="Go forward"
            onClick={() => postPreviewNavigation('roomote-nav-forward')}
          >
            <ArrowRight className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 shrink-0"
            aria-label="Reload preview"
            onClick={() => postPreviewNavigation('roomote-nav-reload')}
          >
            <RefreshCw className="size-3.5" />
          </Button>
          {isWidgetHidden ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 shrink-0 rounded-full px-3 text-xs"
              aria-label="Show preview widget"
              onClick={showPreviewWidget}
            >
              Show widget
            </Button>
          ) : null}

          <div
            className="relative min-w-0 flex-1 cursor-text"
            onClick={() => {
              if (!isEditingUrl) {
                startEditingUrl();
              }
            }}
          >
            {isNavigating ? (
              <Loader2 className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 animate-spin text-muted-foreground" />
            ) : (
              <Lock className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
            )}
            <span
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-8 -translate-y-1/2 text-xs leading-none text-muted-foreground"
            >
              /
            </span>
            <Input
              ref={urlInputRef}
              aria-label="Preview path"
              className="h-8 pl-9 text-xs rounded-xl"
              value={isEditingUrl ? editUrlValue : displayUrl}
              readOnly={!isEditingUrl}
              onFocus={() => {
                if (!isEditingUrl) {
                  startEditingUrl();
                }
              }}
              onBlur={() => setIsEditingUrl(false)}
              onChange={(event) => setEditUrlValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  navigateTo(editUrlValue);
                  return;
                }

                if (event.key === 'Escape') {
                  setIsEditingUrl(false);
                  setEditUrlValue(
                    getDisplayPath(currentUrl ?? effectivePreviewUrl),
                  );
                }
              }}
            />
          </div>

          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 shrink-0"
                  aria-label={
                    isMobileView
                      ? 'Switch to desktop preview'
                      : 'Switch to mobile preview'
                  }
                  onClick={toggleMobileView}
                >
                  <RectangleHorizontal
                    className="size-3.5 transition-transform duration-300"
                    style={{
                      transform: isMobileView
                        ? 'rotate(90deg)'
                        : 'rotate(0deg)',
                    }}
                  />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {isMobileView ? 'Switch to desktop' : 'Switch to mobile'}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      ) : null}

      <div className="relative min-h-0 flex-1 bg-card">
        {iframeSrc ? (
          <div className="relative flex size-full items-center justify-center overflow-hidden bg-zinc-800">
            <div
              className={`relative ${isResizing ? '' : 'transition-all duration-300 ease-in-out'}`}
              style={
                isMobileView
                  ? {
                      width: mobileSize.width,
                      height: mobileSize.height,
                      maxWidth: '100%',
                      maxHeight: '100%',
                    }
                  : { width: '100%', height: '100%' }
              }
            >
              <iframe
                ref={iframeRef}
                title="Live Preview"
                src={iframeSrc}
                className="size-full border border-background bg-background"
                sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
                style={
                  isMobileView
                    ? {
                        borderRadius: 8,
                        boxShadow: '0 0 40px rgba(0, 0, 0, 0.3)',
                      }
                    : undefined
                }
                onLoad={handleIframeLoad}
              />

              {isMobileView ? (
                <>
                  <div
                    className="group absolute top-0 -right-2 h-full w-4 cursor-col-resize"
                    onPointerDown={handleResizePointerDown('x')}
                    onPointerMove={handleResizePointerMove}
                    onPointerUp={handleResizePointerUp}
                  >
                    <div className="absolute top-1/2 left-1/2 h-8 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-zinc-500 opacity-0 transition-opacity group-hover:opacity-100" />
                  </div>
                  <div
                    className="group absolute -bottom-2 left-0 h-4 w-full cursor-row-resize"
                    onPointerDown={handleResizePointerDown('y')}
                    onPointerMove={handleResizePointerMove}
                    onPointerUp={handleResizePointerUp}
                  >
                    <div className="absolute top-1/2 left-1/2 h-1 w-8 -translate-x-1/2 -translate-y-1/2 rounded-full bg-zinc-500 opacity-0 transition-opacity group-hover:opacity-100" />
                  </div>
                  <div
                    className="group absolute -right-2 -bottom-2 h-5 w-5 cursor-nwse-resize"
                    onPointerDown={handleResizePointerDown('xy')}
                    onPointerMove={handleResizePointerMove}
                    onPointerUp={handleResizePointerUp}
                  >
                    <div className="absolute right-1 bottom-1 h-2 w-2 rounded-full bg-zinc-500 opacity-0 transition-opacity group-hover:opacity-100" />
                  </div>
                </>
              ) : null}
            </div>

            {isMobileView ? (
              <div className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-md bg-zinc-700 px-2 py-0.5 text-xs text-zinc-300">
                {Math.round(mobileSize.width)} × {Math.round(mobileSize.height)}
              </div>
            ) : null}
          </div>
        ) : (
          <PreviewSetupState taskRun={taskRun} />
        )}
      </div>
    </div>
  );
}
