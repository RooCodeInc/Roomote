'use client';

import {
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';

import { cn } from '@/lib/utils';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  LoaderCircle,
} from '../primitives';

const IMAGE_ZOOM_MIN = 0.25;
const IMAGE_ZOOM_MAX = 5;
const IMAGE_ZOOM_STEP = 0.25;
const IMAGE_PAN_DRAG_THRESHOLD = 5;
const IMAGE_ZOOM_INDICATOR_HIDE_DELAY_MS = 1200;

function clampImageZoom(value: number): number {
  const rounded = Math.round(value * 100) / 100;
  return Math.min(IMAGE_ZOOM_MAX, Math.max(IMAGE_ZOOM_MIN, rounded));
}

type ImageZoomAnchor = {
  clientX: number;
  clientY: number;
};

interface MediaViewerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  contentClassName?: string;
  viewerClassName?: string;
}

export function MediaViewerDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  contentClassName,
  viewerClassName,
}: MediaViewerDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="max"
        className={cn('overflow-hidden p-0 md:max-w-4xl', contentClassName)}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {description ?? 'Fullscreen media viewer'}
          </DialogDescription>
        </DialogHeader>
        <div
          className={cn(
            'h-[calc(var(--effective-viewport-height)-3rem)] max-h-[calc(var(--effective-viewport-height)-3rem)] md:h-[calc(var(--effective-viewport-height)-5rem)] md:max-h-[calc(var(--effective-viewport-height)-5rem)]',
            viewerClassName,
          )}
        >
          {children}
        </div>
      </DialogContent>
    </Dialog>
  );
}

interface MediaViewerImageProps extends ComponentProps<'div'> {
  src: string | null | undefined;
  alt: string;
}

export function MediaViewerImage({
  src,
  alt,
  className,
  ...props
}: MediaViewerImageProps) {
  const [loadedImageUrl, setLoadedImageUrl] = useState<string | null>(null);
  const [imageZoom, setImageZoom] = useState(1);
  const [isPanning, setIsPanning] = useState(false);
  const [showZoomIndicator, setShowZoomIndicator] = useState(false);
  const [hasInteractedWithZoom, setHasInteractedWithZoom] = useState(false);

  const imageViewportRef = useRef<HTMLDivElement | null>(null);
  const imageElementRef = useRef<HTMLImageElement | null>(null);
  const naturalFitSizeRef = useRef<{ width: number; height: number } | null>(
    null,
  );
  const imageZoomRef = useRef(imageZoom);
  const panStartRef = useRef<{
    clientX: number;
    clientY: number;
    scrollLeft: number;
    scrollTop: number;
    hasMovedPastThreshold: boolean;
  } | null>(null);
  const suppressNextZoomClickRef = useRef(false);
  const clickZoomTimeoutRef = useRef<number | null>(null);
  const zoomIndicatorHideTimeoutRef = useRef<number | null>(null);
  const adjustScrollAfterZoomRef = useRef<
    (nextZoom: number, anchor: ImageZoomAnchor) => void
  >(() => {});

  useEffect(() => {
    if (!src) {
      setLoadedImageUrl(null);
      return;
    }

    setLoadedImageUrl(null);

    const img = new Image();
    let cancelled = false;

    img.onload = () => {
      if (!cancelled) {
        setLoadedImageUrl(src);
      }
    };
    img.src = src;

    return () => {
      cancelled = true;
    };
  }, [src]);

  useEffect(() => {
    setImageZoom(1);
    imageZoomRef.current = 1;
    naturalFitSizeRef.current = null;
    setIsPanning(false);
    setShowZoomIndicator(false);
    setHasInteractedWithZoom(false);
    panStartRef.current = null;
    suppressNextZoomClickRef.current = false;

    if (clickZoomTimeoutRef.current !== null) {
      window.clearTimeout(clickZoomTimeoutRef.current);
      clickZoomTimeoutRef.current = null;
    }

    if (zoomIndicatorHideTimeoutRef.current !== null) {
      window.clearTimeout(zoomIndicatorHideTimeoutRef.current);
      zoomIndicatorHideTimeoutRef.current = null;
    }
  }, [src]);

  useEffect(() => {
    return () => {
      if (clickZoomTimeoutRef.current !== null) {
        window.clearTimeout(clickZoomTimeoutRef.current);
        clickZoomTimeoutRef.current = null;
      }

      if (zoomIndicatorHideTimeoutRef.current !== null) {
        window.clearTimeout(zoomIndicatorHideTimeoutRef.current);
        zoomIndicatorHideTimeoutRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    imageZoomRef.current = imageZoom;
  }, [imageZoom]);

  useEffect(() => {
    const viewport = imageViewportRef.current;
    if (!viewport) {
      return;
    }

    const handleWheelEvent = (event: WheelEvent) => {
      if (!loadedImageUrl) {
        return;
      }

      event.preventDefault();

      const zoomDelta = event.deltaY < 0 ? IMAGE_ZOOM_STEP : -IMAGE_ZOOM_STEP;
      const currentZoom = imageZoomRef.current;
      const nextZoom = clampImageZoom(currentZoom + zoomDelta);

      if (nextZoom === currentZoom) {
        return;
      }

      if (currentZoom === 1 && imageElementRef.current) {
        naturalFitSizeRef.current = {
          width: imageElementRef.current.offsetWidth,
          height: imageElementRef.current.offsetHeight,
        };
      }

      setImageZoom(nextZoom);
      adjustScrollAfterZoomRef.current(nextZoom, {
        clientX: event.clientX,
        clientY: event.clientY,
      });
    };

    viewport.addEventListener('wheel', handleWheelEvent, { passive: false });

    return () => {
      viewport.removeEventListener('wheel', handleWheelEvent);
    };
  }, [loadedImageUrl]);

  if (!src) {
    return null;
  }

  const clearPendingClickZoom = () => {
    if (clickZoomTimeoutRef.current !== null) {
      window.clearTimeout(clickZoomTimeoutRef.current);
      clickZoomTimeoutRef.current = null;
    }
  };

  const setZoomIndicatorVisibility = (nextZoom: number) => {
    setShowZoomIndicator(true);

    if (zoomIndicatorHideTimeoutRef.current !== null) {
      window.clearTimeout(zoomIndicatorHideTimeoutRef.current);
      zoomIndicatorHideTimeoutRef.current = null;
    }

    if (nextZoom === 1) {
      zoomIndicatorHideTimeoutRef.current = window.setTimeout(() => {
        setShowZoomIndicator(false);
      }, IMAGE_ZOOM_INDICATOR_HIDE_DELAY_MS);
    }
  };

  adjustScrollAfterZoomRef.current = (
    nextZoom: number,
    anchor: ImageZoomAnchor,
  ) => {
    const image = imageElementRef.current;
    const imageRect = image?.getBoundingClientRect();

    const anchorXRatio =
      imageRect && imageRect.width > 0
        ? Math.min(
            1,
            Math.max(0, (anchor.clientX - imageRect.left) / imageRect.width),
          )
        : 0.5;
    const anchorYRatio =
      imageRect && imageRect.height > 0
        ? Math.min(
            1,
            Math.max(0, (anchor.clientY - imageRect.top) / imageRect.height),
          )
        : 0.5;

    setHasInteractedWithZoom(true);
    setZoomIndicatorVisibility(nextZoom);

    if (!image) {
      return;
    }

    requestAnimationFrame(() => {
      const viewport = imageViewportRef.current;
      const currentImage = imageElementRef.current;

      if (!viewport || !currentImage) {
        return;
      }

      const currentImageRect = currentImage.getBoundingClientRect();

      viewport.scrollLeft +=
        currentImageRect.left +
        currentImageRect.width * anchorXRatio -
        anchor.clientX;
      viewport.scrollTop +=
        currentImageRect.top +
        currentImageRect.height * anchorYRatio -
        anchor.clientY;
    });
  };

  const setImageZoomWithAnchor = (
    nextZoom: number,
    anchor?: ImageZoomAnchor,
  ) => {
    const clampedZoom = clampImageZoom(nextZoom);
    const currentZoom = imageZoomRef.current;

    if (clampedZoom === currentZoom) {
      return;
    }

    if (currentZoom === 1 && imageElementRef.current) {
      naturalFitSizeRef.current = {
        width: imageElementRef.current.offsetWidth,
        height: imageElementRef.current.offsetHeight,
      };
    }

    imageZoomRef.current = clampedZoom;
    setImageZoom(clampedZoom);

    if (anchor) {
      adjustScrollAfterZoomRef.current(clampedZoom, anchor);
    } else {
      setHasInteractedWithZoom(true);
      setZoomIndicatorVisibility(clampedZoom);
    }
  };

  const handleImageClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!loadedImageUrl) {
      return;
    }

    if (suppressNextZoomClickRef.current) {
      suppressNextZoomClickRef.current = false;
      return;
    }

    clearPendingClickZoom();

    const clickClientX = event.clientX;
    const clickClientY = event.clientY;

    clickZoomTimeoutRef.current = window.setTimeout(() => {
      setImageZoomWithAnchor(imageZoomRef.current + IMAGE_ZOOM_STEP, {
        clientX: clickClientX,
        clientY: clickClientY,
      });
      clickZoomTimeoutRef.current = null;
    }, 200);
  };

  const handleImageDoubleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!loadedImageUrl) {
      return;
    }

    event.preventDefault();
    clearPendingClickZoom();
    setImageZoomWithAnchor(1, {
      clientX: event.clientX,
      clientY: event.clientY,
    });
  };

  const handleImageMouseDown = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!loadedImageUrl || event.button !== 0 || imageZoom <= 1) {
      return;
    }

    const viewport = imageViewportRef.current;
    if (!viewport) {
      return;
    }

    panStartRef.current = {
      clientX: event.clientX,
      clientY: event.clientY,
      scrollLeft: viewport.scrollLeft,
      scrollTop: viewport.scrollTop,
      hasMovedPastThreshold: false,
    };
  };

  const handleImageMouseMove = (event: ReactMouseEvent<HTMLDivElement>) => {
    const panStart = panStartRef.current;
    const viewport = imageViewportRef.current;

    if (!panStart || !viewport) {
      return;
    }

    const deltaX = event.clientX - panStart.clientX;
    const deltaY = event.clientY - panStart.clientY;
    const hasMovedPastThreshold =
      Math.hypot(deltaX, deltaY) > IMAGE_PAN_DRAG_THRESHOLD;

    if (hasMovedPastThreshold && !panStart.hasMovedPastThreshold) {
      panStart.hasMovedPastThreshold = true;
      setIsPanning(true);
      suppressNextZoomClickRef.current = true;
    }

    if (!panStart.hasMovedPastThreshold) {
      return;
    }

    event.preventDefault();
    viewport.scrollLeft = panStart.scrollLeft - deltaX;
    viewport.scrollTop = panStart.scrollTop - deltaY;
  };

  const stopImagePan = () => {
    if (panStartRef.current?.hasMovedPastThreshold) {
      suppressNextZoomClickRef.current = true;
    }

    panStartRef.current = null;
    setIsPanning(false);
  };

  const zoomPercent = Math.round(imageZoom * 100);
  const imageCursorClass = isPanning
    ? 'cursor-grabbing'
    : imageZoom >= IMAGE_ZOOM_MAX
      ? 'cursor-default'
      : imageZoom > 1
        ? 'cursor-grab'
        : 'cursor-zoom-in';
  const shouldRenderZoomIndicator = imageZoom !== 1 || hasInteractedWithZoom;

  return (
    <div className={cn('relative h-full w-full', className)} {...props}>
      <div
        ref={imageViewportRef}
        className="h-full w-full overflow-auto bg-zinc-800 p-4"
        onClick={handleImageClick}
        onDoubleClick={handleImageDoubleClick}
        onMouseDown={handleImageMouseDown}
        onMouseMove={handleImageMouseMove}
        onMouseUp={stopImagePan}
        onMouseLeave={stopImagePan}
      >
        {loadedImageUrl ? (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            ref={imageElementRef}
            src={loadedImageUrl}
            alt={alt}
            className={cn(
              'block m-auto rounded-xl object-contain select-none transition-[width] duration-150',
              imageZoom === 1
                ? 'max-h-full max-w-full'
                : 'h-auto w-auto max-h-none max-w-none',
              imageCursorClass,
            )}
            style={
              imageZoom === 1 || !naturalFitSizeRef.current
                ? undefined
                : {
                    width: `${Math.round(naturalFitSizeRef.current.width * imageZoom)}px`,
                  }
            }
            draggable={false}
            onDragStart={(event) => event.preventDefault()}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <LoaderCircle className="size-6 animate-spin text-muted-foreground" />
          </div>
        )}
      </div>

      {shouldRenderZoomIndicator ? (
        <div
          className={cn(
            'pointer-events-none absolute bottom-3 right-3 rounded-full bg-black/60 px-2 py-0.5 text-xs text-white tabular-nums transition-opacity duration-200',
            showZoomIndicator || imageZoom !== 1 ? 'opacity-100' : 'opacity-0',
          )}
        >
          {zoomPercent}%
        </div>
      ) : null}
    </div>
  );
}
