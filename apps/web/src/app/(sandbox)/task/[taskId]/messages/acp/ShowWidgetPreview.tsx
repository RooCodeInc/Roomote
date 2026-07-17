'use client';

import { useMemo } from 'react';

import {
  buildShowWidgetSrcDoc,
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
  const srcDoc = useMemo(() => buildShowWidgetSrcDoc(widget), [widget]);
  const label = widget.title?.trim() || 'Widget';

  return (
    <div className="mt-2 overflow-hidden rounded-lg border border-border bg-card">
      {widget.title ? (
        <div className="border-b border-border px-3 py-1.5 text-xs font-medium text-muted-foreground">
          {widget.title}
        </div>
      ) : null}
      <iframe
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
