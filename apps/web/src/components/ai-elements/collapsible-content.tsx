'use client';

import {
  type HTMLAttributes,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { ChevronDownIcon } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Button } from '../system';

/** Default collapsed height in pixels. */
const DEFAULT_MAX_HEIGHT = 300;

/** Props passed to a custom toggle renderer. */
export type CollapsibleToggleRenderProps = {
  isExpanded: boolean;
  toggle: () => void;
};

type CollapsibleContentProps = HTMLAttributes<HTMLDivElement> & {
  /** Maximum height (px) before content is collapsed. @default 300 */
  maxCollapsedHeight?: number;
  /**
   * Custom renderer for the expand/collapse toggle button.
   * Receives the current expanded state and a toggle callback.
   * When omitted a default "More / Less" button is rendered.
   */
  renderToggle?: (props: CollapsibleToggleRenderProps) => ReactNode;
};

/** Default toggle button used when no `renderToggle` prop is provided. */
const DefaultCollapsibleToggle = ({
  isExpanded,
  toggle,
}: CollapsibleToggleRenderProps) => (
  <Button variant="ghost" size="sm" onClick={toggle}>
    {isExpanded ? 'Less' : 'More'}
    <ChevronDownIcon
      className={cn('size-3 transition-transform', isExpanded && 'rotate-180')}
    />
  </Button>
);

/**
 * Wraps children and collapses content that exceeds `maxCollapsedHeight`.
 * Shows a gradient fade overlay and a toggle (customisable via `renderToggle`).
 */
export const CollapsibleContent = ({
  children,
  className,
  maxCollapsedHeight = DEFAULT_MAX_HEIGHT,
  renderToggle,
  ...props
}: CollapsibleContentProps) => {
  const contentRef = useRef<HTMLDivElement>(null);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);

  const toggle = useCallback(() => setIsExpanded((prev) => !prev), []);

  const measure = useCallback(() => {
    const el = contentRef.current;
    if (!el) return;
    setIsOverflowing(el.scrollHeight > maxCollapsedHeight);
  }, [maxCollapsedHeight]);

  useEffect(() => {
    measure();

    // Re-measure if images or other async content loads.
    const el = contentRef.current;
    if (!el) return;

    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure]);

  const needsCollapse = isOverflowing && !isExpanded;

  const Toggle = renderToggle ?? DefaultCollapsibleToggle;

  return (
    <div className={cn('relative', className)} {...props}>
      <div
        ref={contentRef}
        className={cn('overflow-hidden', needsCollapse && 'mask-fade-bottom')}
        style={
          needsCollapse ? { maxHeight: `${maxCollapsedHeight}px` } : undefined
        }
      >
        {children}
      </div>

      {isOverflowing && <Toggle isExpanded={isExpanded} toggle={toggle} />}
    </div>
  );
};
