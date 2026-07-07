'use client';

import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';

interface LazyViewportItemProps {
  children: ReactNode;
  anchorId?: string;
  forceVisible?: boolean;
  rootRef?: RefObject<HTMLElement | null>;
  rootMargin?: string;
  collapseDelayMs?: number;
  estimatedHeight?: number;
  defaultVisible?: boolean;
  observerSetupDelayFrames?: number;
}

export function LazyViewportItem({
  children,
  anchorId,
  forceVisible = false,
  rootRef,
  rootMargin = '0px',
  collapseDelayMs = 300,
  estimatedHeight,
  defaultVisible = false,
  observerSetupDelayFrames = 0,
}: LazyViewportItemProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const collapseTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const placeholderHeightRef = useRef(estimatedHeight ?? 0);

  const [nearViewport, setNearViewport] = useState(defaultVisible);
  const [placeholderHeight, setPlaceholderHeight] = useState(
    estimatedHeight ?? 0,
  );

  const shouldRender = forceVisible || nearViewport;

  const updatePlaceholderHeight = (nextHeight: number) => {
    if (nextHeight <= 0) {
      return;
    }

    placeholderHeightRef.current = nextHeight;
    setPlaceholderHeight((currentHeight) =>
      currentHeight === nextHeight ? currentHeight : nextHeight,
    );
  };

  useEffect(() => {
    if ((estimatedHeight ?? 0) <= 0 || shouldRender) {
      return;
    }

    updatePlaceholderHeight(estimatedHeight!);
  }, [estimatedHeight, shouldRender]);

  useEffect(() => {
    if (!forceVisible) {
      return;
    }

    if (collapseTimeoutRef.current !== null) {
      clearTimeout(collapseTimeoutRef.current);
      collapseTimeoutRef.current = null;
    }

    setNearViewport(true);
  }, [forceVisible]);

  useEffect(() => {
    if (!shouldRender) {
      return;
    }

    const el = wrapperRef.current;

    if (!el) {
      return;
    }

    const measure = () => {
      updatePlaceholderHeight(el.offsetHeight);
    };

    measure();

    if (typeof ResizeObserver === 'undefined') {
      return;
    }

    const observer = new ResizeObserver(measure);
    observer.observe(el);

    return () => observer.disconnect();
  }, [shouldRender]);

  useEffect(() => {
    if (forceVisible) {
      return;
    }

    const el = wrapperRef.current;

    if (!el) {
      return;
    }

    if (typeof IntersectionObserver === 'undefined') {
      setNearViewport(true);
      return;
    }

    let observer: IntersectionObserver | undefined;
    const rafHandles: number[] = [];

    const clearCollapseTimeout = () => {
      if (collapseTimeoutRef.current !== null) {
        clearTimeout(collapseTimeoutRef.current);
        collapseTimeoutRef.current = null;
      }
    };

    const scheduleCollapse = () => {
      const measuredHeight = el.offsetHeight;

      if (measuredHeight > 0) {
        updatePlaceholderHeight(measuredHeight);
      }

      const preservedHeight =
        measuredHeight || placeholderHeightRef.current || estimatedHeight || 0;

      if (preservedHeight <= 0) {
        return;
      }

      updatePlaceholderHeight(preservedHeight);
      clearCollapseTimeout();
      collapseTimeoutRef.current = setTimeout(() => {
        setNearViewport(false);
        collapseTimeoutRef.current = null;
      }, collapseDelayMs);
    };

    const setupObserver = () => {
      observer = new IntersectionObserver(
        ([entry]) => {
          if (!entry) {
            return;
          }

          if (entry.isIntersecting) {
            clearCollapseTimeout();
            setNearViewport(true);
            return;
          }

          scheduleCollapse();
        },
        {
          root: rootRef?.current ?? null,
          rootMargin,
        },
      );

      observer.observe(el);
    };

    const scheduleObserverSetup = (remainingFrames: number) => {
      if (remainingFrames <= 0) {
        setupObserver();
        return;
      }

      const handle = requestAnimationFrame(() => {
        scheduleObserverSetup(remainingFrames - 1);
      });

      rafHandles.push(handle);
    };

    scheduleObserverSetup(observerSetupDelayFrames);

    return () => {
      rafHandles.forEach((handle) => cancelAnimationFrame(handle));
      clearCollapseTimeout();
      observer?.disconnect();
    };
  }, [
    forceVisible,
    rootRef,
    rootMargin,
    collapseDelayMs,
    estimatedHeight,
    observerSetupDelayFrames,
  ]);

  return (
    <div
      ref={wrapperRef}
      id={anchorId}
      style={
        !shouldRender && placeholderHeight > 0
          ? { height: placeholderHeight, overflow: 'hidden' }
          : undefined
      }
    >
      {shouldRender ? children : null}
    </div>
  );
}
