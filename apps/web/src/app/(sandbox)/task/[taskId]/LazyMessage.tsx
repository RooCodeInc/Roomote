'use client';

import { type ReactNode } from 'react';

import { LazyViewportItem } from './LazyViewportItem';

/**
 * Generous margin around the viewport within which messages are mounted.
 * Elements beyond this distance are replaced with a height-preserving
 * placeholder to keep the DOM lean on long conversations.
 */
const VIEWPORT_MARGIN = '4000px 0px';
const COLLAPSE_DELAY_MS = 300;

interface LazyMessageProps {
  children: ReactNode;

  /** Anchor ID placed on the wrapper so hash-scroll works even when content is unmounted. */
  anchorId?: string;

  /** When true, always render content (e.g. streaming messages). */
  forceVisible?: boolean;
}

/**
 * Intersection-observer wrapper that defers rendering of off-screen messages.
 *
 * While a message is far from the viewport its children are unmounted and the
 * wrapper preserves the last-measured height so scroll position stays stable.
 * When the wrapper enters the generous margin the children are re-mounted.
 */
export function LazyMessage({
  children,
  anchorId,
  forceVisible,
}: LazyMessageProps) {
  return (
    <LazyViewportItem
      anchorId={anchorId}
      forceVisible={forceVisible}
      rootMargin={VIEWPORT_MARGIN}
      collapseDelayMs={COLLAPSE_DELAY_MS}
      defaultVisible={true}
      observerSetupDelayFrames={2}
    >
      {children}
    </LazyViewportItem>
  );
}
