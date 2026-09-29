'use client';

import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  AnimatePresence,
  LayoutGroup,
  MotionConfig,
  motion,
  useReducedMotion,
} from 'motion/react';

import {
  consumeSessionBoardMove,
  registerSessionBoard,
} from '@/components/sessions/session-board-motion';

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

const FLIGHT_TRANSITION = {
  duration: 0.68,
  ease: [0.22, 0.8, 0.24, 1] as const,
  times: [0, 0.18, 0.5, 0.82, 1],
};

const REST_ANIMATION = {
  y: 0,
  scale: 1,
  boxShadow: '0 0 0 0 rgba(0, 0, 0, 0)',
};

const FLIGHT_ANIMATION = {
  // The inner layer adds a small lift arc to the outer position-only layout
  // projection without changing the card's measured layout box.
  y: [0, -7, -18, -8, 0],
  scale: [1, 1.05, 1.1, 1.04, 1],
  boxShadow: [
    '0 0 0 0 rgba(0, 0, 0, 0)',
    '0 8px 16px -12px rgba(0, 0, 0, 0.1)',
    '0 36px 72px -18px rgba(0, 0, 0, 0.38), 0 14px 28px -12px rgba(0, 0, 0, 0.2)',
    '0 8px 16px -12px rgba(0, 0, 0, 0.1)',
    '0 0 0 0 rgba(0, 0, 0, 0)',
  ],
};

type SessionBoardCardRegistry = {
  register: (sessionId: string, column: string) => boolean;
  unregister: (sessionId: string, column: string) => void;
};

const SessionBoardCardRegistryContext =
  createContext<SessionBoardCardRegistry | null>(null);

export function SessionBoard({ children }: { children: ReactNode }) {
  const cards = useRef(
    new Map<
      string,
      { column: string; removalTimer: ReturnType<typeof setTimeout> | null }
    >(),
  );
  const register = useCallback((sessionId: string, column: string) => {
    const current = cards.current.get(sessionId);
    if (current?.removalTimer) clearTimeout(current.removalTimer);
    cards.current.set(sessionId, { column, removalTimer: null });
    return current !== undefined && current.column !== column;
  }, []);
  const unregister = useCallback((sessionId: string, column: string) => {
    const current = cards.current.get(sessionId);
    if (!current || current.column !== column) return;
    current.removalTimer = setTimeout(
      () => {
        if (cards.current.get(sessionId) === current)
          cards.current.delete(sessionId);
      },
      FLIGHT_TRANSITION.duration * 2 * 1000,
    );
  }, []);

  useLayoutEffect(() => registerSessionBoard(), []);

  return (
    <MotionConfig reducedMotion="user">
      <SessionBoardCardRegistryContext.Provider
        value={{ register, unregister }}
      >
        <LayoutGroup id="session-board">
          <div className="relative grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,16rem),1fr))] gap-3 p-4">
            <AnimatePresence initial={false} mode="popLayout">
              {children}
            </AnimatePresence>
          </div>
        </LayoutGroup>
      </SessionBoardCardRegistryContext.Provider>
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
  column,
  children,
}: {
  sessionId: string;
  column: string;
  children: ReactNode;
}) {
  const reducedMotion = useReducedMotion() ?? false;
  const registry = useContext(SessionBoardCardRegistryContext);
  const [isFlying, setIsFlying] = useState(false);

  useLayoutEffect(() => {
    const moved = registry?.register(sessionId, column) ?? false;
    const announcedMove = consumeSessionBoardMove(sessionId, column);
    if ((moved || announcedMove) && !reducedMotion) setIsFlying(true);

    return () => registry?.unregister(sessionId, column);
  }, [column, reducedMotion, registry, sessionId]);

  return (
    <motion.div
      layout="position"
      layoutId={`session-board-card-${sessionId}`}
      initial={false}
      data-session-board-card-id={sessionId}
      data-session-board-layout-id={`session-board-card-${sessionId}`}
      data-session-board-moving={isFlying ? 'true' : 'false'}
      className={isFlying ? 'relative z-10 bg-card' : 'relative bg-card'}
    >
      <motion.div
        initial={false}
        animate={isFlying && !reducedMotion ? FLIGHT_ANIMATION : REST_ANIMATION}
        transition={
          isFlying && !reducedMotion ? FLIGHT_TRANSITION : { duration: 0 }
        }
        onAnimationComplete={isFlying ? () => setIsFlying(false) : undefined}
        data-session-board-flight={isFlying ? 'active' : 'resting'}
        style={{ transformOrigin: 'center center' }}
        className="relative w-full"
      >
        {children}
      </motion.div>
    </motion.div>
  );
}
