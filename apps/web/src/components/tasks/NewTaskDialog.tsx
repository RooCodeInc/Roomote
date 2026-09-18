'use client';

import { useEffect, useState, type CSSProperties } from 'react';

import { Dialog, DialogContent, DialogTitle } from '@/components/system';
import { NewTaskForm } from './NewTaskForm';

type DialogViewportStyle = CSSProperties & {
  '--new-task-dialog-bottom': string;
  '--new-task-dialog-height': string;
};

const defaultViewportStyle: DialogViewportStyle = {
  '--new-task-dialog-bottom': '0px',
  '--new-task-dialog-height': 'var(--effective-viewport-height)',
};

export function NewTaskDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [viewportStyle, setViewportStyle] =
    useState<DialogViewportStyle>(defaultViewportStyle);

  useEffect(() => {
    if (!open) {
      setViewportStyle(defaultViewportStyle);
      return;
    }

    const visualViewport = window.visualViewport;
    const updateViewportStyle = () => {
      if (!visualViewport || window.innerWidth >= 768) {
        setViewportStyle(defaultViewportStyle);
        return;
      }

      const visibleBottom = Math.min(
        window.innerHeight,
        visualViewport.offsetTop + visualViewport.height,
      );

      setViewportStyle({
        '--new-task-dialog-bottom': `${Math.max(0, window.innerHeight - visibleBottom)}px`,
        '--new-task-dialog-height': `${visualViewport.height}px`,
      });
    };

    updateViewportStyle();
    visualViewport?.addEventListener('resize', updateViewportStyle);
    visualViewport?.addEventListener('scroll', updateViewportStyle);
    window.addEventListener('resize', updateViewportStyle);
    window.addEventListener('orientationchange', updateViewportStyle);

    return () => {
      visualViewport?.removeEventListener('resize', updateViewportStyle);
      visualViewport?.removeEventListener('scroll', updateViewportStyle);
      window.removeEventListener('resize', updateViewportStyle);
      window.removeEventListener('orientationchange', updateViewportStyle);
    };
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="2xl"
        aria-describedby={undefined}
        className="bottom-(--new-task-dialog-bottom) max-h-[calc(var(--new-task-dialog-height)-3rem)] p-0 md:bottom-auto md:max-h-[calc(var(--effective-viewport-height)-5rem)]"
        overlayClassName="bg-black/75"
        style={viewportStyle}
      >
        <DialogTitle className="sr-only">New Session</DialogTitle>
        <NewTaskForm
          animate={false}
          onTaskStarted={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}
