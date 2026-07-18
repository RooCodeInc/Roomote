'use client';

import { useLayoutEffect, useMemo, useRef, useState } from 'react';

import {
  buildShowWidgetSrcDoc,
  readShowWidgetHostTheme,
  type ShowWidgetHostTheme,
  type ShowWidgetPayload,
} from './show-widget-tool-result';

interface ShowWidgetPreviewProps {
  widget: ShowWidgetPayload;
}

/**
 * Presentational HTML widget card.
 * Mounts model HTML in a fully locked-down sandboxed iframe (no scripts,
 * forms, top-navigation, or same-origin access).
 */
export function ShowWidgetPreview({ widget }: ShowWidgetPreviewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [hostTheme, setHostTheme] = useState<ShowWidgetHostTheme | null>(null);
  const srcDoc = useMemo(
    () => buildShowWidgetSrcDoc(widget, hostTheme ?? undefined),
    [hostTheme, widget],
  );
  const label = widget.title?.trim() || 'Widget';

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }

    const syncTheme = () => setHostTheme(readShowWidgetHostTheme(host));
    const observer = new MutationObserver(syncTheme);

    syncTheme();
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style'],
    });
    if (document.body !== document.documentElement) {
      observer.observe(document.body, {
        attributes: true,
        attributeFilter: ['class', 'style'],
      });
    }

    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={hostRef}
      className="mt-2 overflow-hidden rounded-lg border border-border bg-card"
    >
      {widget.title ? (
        <div className="border-b border-border px-3 py-1.5 text-xs font-medium text-muted-foreground">
          {widget.title}
        </div>
      ) : null}
      <iframe
        key={hostTheme?.colorScheme ?? 'initial'}
        title={label}
        srcDoc={srcDoc}
        sandbox=""
        referrerPolicy="no-referrer"
        loading="lazy"
        className="block w-full border-0 bg-transparent"
        style={{ height: widget.height }}
      />
    </div>
  );
}
