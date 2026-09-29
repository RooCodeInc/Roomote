'use client';

import { forwardRef, useState, type ReactNode } from 'react';
import {
  AnimatePresence,
  LayoutGroup,
  MotionConfig,
  motion,
  useReducedMotion,
} from 'motion/react';

const BOARD_LAYOUT_TRANSITION = {
  type: 'spring' as const,
  stiffness: 500,
  damping: 38,
  mass: 0.8,
};

const COLUMN_TRANSITION = {
  duration: 0.18,
  ease: 'easeOut' as const,
};

export function SessionBoard({ children }: { children: ReactNode }) {
  return (
    <MotionConfig reducedMotion="user">
      <LayoutGroup id="session-board">
        <div className="relative grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,16rem),1fr))] gap-3 p-4">
          <AnimatePresence initial={false} mode="popLayout">
            {children}
          </AnimatePresence>
        </div>
      </LayoutGroup>
    </MotionConfig>
  );
}

export const SessionBoardColumn = forwardRef<
  HTMLElement,
  {
    column: string;
    label: string;
    count: number;
    children: ReactNode;
  }
>(function SessionBoardColumn({ column, label, count, children }, ref) {
  const reducedMotion = useReducedMotion() ?? false;

  return (
    <motion.section
      ref={ref}
      layout="position"
      initial={reducedMotion ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={reducedMotion ? undefined : { opacity: 0, y: -8 }}
      transition={
        reducedMotion
          ? { duration: 0 }
          : {
              layout: BOARD_LAYOUT_TRANSITION,
              opacity: COLUMN_TRANSITION,
              y: COLUMN_TRANSITION,
            }
      }
      aria-labelledby={`session-board-${column}`}
      data-session-board-column={column}
      className="relative min-w-0 has-[[data-session-board-moving=true]]:z-20"
    >
      <header className="mb-2 flex cursor-default items-center justify-between gap-2">
        <h2
          id={`session-board-${column}`}
          className="text-sm font-medium capitalize"
        >
          {label}
        </h2>
        <span className="text-xs text-muted-foreground">{count}</span>
      </header>
      <div className="divide-y-2 divide-background bg-card">{children}</div>
    </motion.section>
  );
});

export function SessionBoardCard({
  sessionId,
  children,
}: {
  sessionId: string;
  children: ReactNode;
}) {
  const reducedMotion = useReducedMotion() ?? false;
  const [isMoving, setIsMoving] = useState(false);

  return (
    <motion.div
      layout="position"
      layoutId={`session-board-card-${sessionId}`}
      initial={false}
      transition={
        reducedMotion ? { duration: 0 } : { layout: BOARD_LAYOUT_TRANSITION }
      }
      onLayoutAnimationStart={() => {
        if (!reducedMotion) setIsMoving(true);
      }}
      onLayoutAnimationComplete={() => setIsMoving(false)}
      data-session-board-card-id={sessionId}
      data-session-board-layout-id={`session-board-card-${sessionId}`}
      data-session-board-moving={isMoving ? 'true' : 'false'}
      className={
        isMoving
          ? 'relative z-10 bg-card shadow-2xl ring-1 ring-foreground/10 transition-[box-shadow] duration-200 motion-reduce:transition-none'
          : 'relative bg-card transition-[box-shadow] duration-200 motion-reduce:transition-none'
      }
    >
      {children}
    </motion.div>
  );
}
