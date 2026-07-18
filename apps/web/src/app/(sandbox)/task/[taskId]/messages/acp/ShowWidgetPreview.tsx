'use client';

import { useMemo } from 'react';

import {
  buildShowWidgetSrcDoc,
  type ShowWidgetPayload,
} from './show-widget-tool-result';
import { useShowWidgetHostTheme } from './use-show-widget-host-theme';

interface ShowWidgetPreviewProps {
  widget: ShowWidgetPayload;
}

/**
 * Presentational HTML widget card.
 * Mounts model HTML in a fully locked-down sandboxed iframe (no scripts,
 * forms, top-navigation, or same-origin access).
 */
export function ShowWidgetPreview({ widget }: ShowWidgetPreviewProps) {
  const { hostRef, hostTheme, hostThemeKey } = useShowWidgetHostTheme();
  const srcDoc = useMemo(
    () => buildShowWidgetSrcDoc(widget, hostTheme ?? undefined),
    [hostTheme, widget],
  );
  const label = widget.title?.trim() || 'Widget';

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
        key={hostThemeKey}
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
