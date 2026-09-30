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
  type SyntheticEvent,
} from 'react';
import {
  DndContext,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type Active,
  type Announcements,
  type DragCancelEvent,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  getSessionStatusLabel,
  type SessionBoardColumn as SessionBoardColumnStatus,
} from '@roomote/types';
import {
  AnimatePresence,
  LayoutGroup,
  MotionConfig,
  motion,
  useReducedMotion,
} from 'motion/react';

import { useSessionStatusMutation } from '@/components/sessions/use-session-status-mutation';
import {
  canDropSessionBoardCard,
  getSessionBoardDropStatus,
  sessionBoardCollisionDetection,
  sessionBoardKeyboardCoordinates,
  type SessionBoardDragData,
} from '@/components/sessions/session-board-dnd';
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

type SessionBoardDndState = {
  isDragging: boolean;
  statusMutationPending: boolean;
  isDropTarget: (column: string) => boolean;
  isSourceColumn: (column: string) => boolean;
};

const SessionBoardCardRegistryContext =
  createContext<SessionBoardCardRegistry | null>(null);
const SessionBoardDndContext = createContext<SessionBoardDndState | null>(null);

const COLUMN_HEADER_CLASSES: Partial<Record<SessionBoardColumnStatus, string>> =
  {
    needs_input: 'text-warning',
    blocked: 'text-destructive',
  };

function isInteractiveDragTarget(
  target: EventTarget | null,
  currentTarget: EventTarget | null,
) {
  return (
    target instanceof Element &&
    target !== currentTarget &&
    target.closest(
      'a, button, input, textarea, select, [role="button"], [contenteditable="true"], [data-session-board-no-drag]',
    ) !== null
  );
}

function getDragData(active: Active): SessionBoardDragData | undefined {
  return active.data.current as SessionBoardDragData | undefined;
}

const sessionBoardAnnouncements: Announcements = {
  onDragStart: ({ active }) => {
    const data = getDragData(active);
    if (!data) return;
    return `Picked up ${data.title}. Current status ${getSessionStatusLabel(data.column)}. Use the arrow keys to choose a status, then press Space or Enter to drop, or Escape to cancel.`;
  },
  onDragOver: ({ active, over }) => {
    const data = getDragData(active);
    if (!data || !over) return;

    const targetStatus = getSessionBoardDropStatus(over.id);
    if (!targetStatus) {
      return `${getSessionStatusLabel(String(over.id))} is not available for manual status changes.`;
    }
    if (targetStatus === data.column) {
      return `${data.title} is already in ${getSessionStatusLabel(targetStatus)}.`;
    }
    return `Over ${getSessionStatusLabel(targetStatus)}. Press Space or Enter to drop.`;
  },
  onDragEnd: ({ active, over }) => {
    const data = getDragData(active);
    if (!data || !over)
      return 'Move canceled because no valid status column was selected.';

    const targetStatus = getSessionBoardDropStatus(over.id);
    if (!targetStatus)
      return 'Move canceled because that column is unavailable.';
    if (targetStatus === data.column) {
      return `${data.title} remains in ${getSessionStatusLabel(data.column)}.`;
    }
    if (!canDropSessionBoardCard(data.column, targetStatus, data.canManage)) {
      return `${data.title} remains in ${getSessionStatusLabel(data.column)}.`;
    }
    return `Dropped ${data.title}. Updating status to ${getSessionStatusLabel(targetStatus)}.`;
  },
  onDragCancel: ({ active }) => {
    const data = getDragData(active);
    return data
      ? `Move canceled. ${data.title} remains in ${getSessionStatusLabel(data.column)}.`
      : 'Move canceled.';
  },
};

export function SessionBoard({ children }: { children: ReactNode }) {
  const cards = useRef(
    new Map<
      string,
      { column: string; removalTimer: ReturnType<typeof setTimeout> | null }
    >(),
  );
  const [activeDrag, setActiveDrag] = useState<{
    column: SessionBoardColumnStatus;
  } | null>(null);
  const statusMutation = useSessionStatusMutation();
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 250, tolerance: 5 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sessionBoardKeyboardCoordinates,
    }),
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
  const handleDragStart = useCallback((event: DragStartEvent) => {
    const data = getDragData(event.active);
    if (!data?.canManage) return;
    data.keyboardColumn = undefined;
    setActiveDrag({ column: data.column });
  }, []);
  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const data = getDragData(event.active);
      const targetStatus = getSessionBoardDropStatus(event.over?.id);
      if (data) data.keyboardColumn = undefined;
      setActiveDrag(null);

      if (
        !data ||
        !targetStatus ||
        targetStatus === data.column ||
        !canDropSessionBoardCard(data.column, targetStatus, data.canManage)
      ) {
        return;
      }

      statusMutation.mutate({
        sessionId: String(event.active.id),
        status: targetStatus,
      });
    },
    [statusMutation],
  );
  const handleDragCancel = useCallback((event: DragCancelEvent) => {
    const data = getDragData(event.active);
    if (data) data.keyboardColumn = undefined;
    setActiveDrag(null);
  }, []);
  const isDropTarget = useCallback(
    (column: string) =>
      activeDrag !== null &&
      !statusMutation.isPending &&
      canDropSessionBoardCard(activeDrag.column, column, true),
    [activeDrag, statusMutation.isPending],
  );
  const isSourceColumn = useCallback(
    (column: string) => activeDrag?.column === column,
    [activeDrag],
  );
  const dndState: SessionBoardDndState = {
    isDragging: activeDrag !== null,
    statusMutationPending: statusMutation.isPending,
    isDropTarget,
    isSourceColumn,
  };

  useLayoutEffect(() => registerSessionBoard(), []);

  return (
    <DndContext
      id="session-board-dnd"
      sensors={sensors}
      collisionDetection={sessionBoardCollisionDetection}
      accessibility={{
        announcements: sessionBoardAnnouncements,
        screenReaderInstructions: {
          draggable:
            'To move a session, press Space or Enter. Use the arrow keys to choose another status, then press Space or Enter to drop, or press Escape to cancel.',
        },
      }}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <MotionConfig reducedMotion="user">
        <SessionBoardDndContext.Provider value={dndState}>
          <SessionBoardCardRegistryContext.Provider
            value={{ register, unregister }}
          >
            <LayoutGroup id="session-board">
              <div
                data-session-board-dragging={activeDrag !== null}
                className="group/board relative grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,16rem),1fr))] gap-3 p-4 md:min-h-0 md:flex-1 md:grid-flow-col md:auto-cols-[minmax(16rem,1fr)] md:grid-cols-none md:overflow-x-auto"
              >
                <AnimatePresence initial={false} mode="popLayout">
                  {children}
                </AnimatePresence>
              </div>
            </LayoutGroup>
          </SessionBoardCardRegistryContext.Provider>
        </SessionBoardDndContext.Provider>
      </MotionConfig>
    </DndContext>
  );
}

export const SessionBoardColumn = forwardRef<
  HTMLElement,
  {
    column: SessionBoardColumnStatus;
    label: string;
    count: number;
    children: ReactNode;
  }
>(function SessionBoardColumn({ column, label, count, children }, ref) {
  const reducedMotion = useReducedMotion() ?? false;
  const dnd = useContext(SessionBoardDndContext);
  const isDropTarget = dnd?.isDropTarget(column) ?? false;
  const isSourceColumn = dnd?.isSourceColumn(column) ?? false;
  const isDragging = dnd?.isDragging ?? false;
  const droppable = useDroppable({
    id: column,
    disabled: !isDropTarget,
    data: { column },
  });
  const setRefs = useCallback(
    (node: HTMLElement | null) => {
      droppable.setNodeRef(node);
      if (typeof ref === 'function') ref(node);
      else if (ref) ref.current = node;
    },
    [droppable, ref],
  );

  if (count === 0 && !isDropTarget) return null;

  const dropTargetState = !isDragging
    ? 'inactive'
    : droppable.isOver
      ? 'over'
      : isSourceColumn
        ? 'source'
        : isDropTarget
          ? 'available'
          : 'unavailable';
  const dropClasses =
    dropTargetState === 'over'
      ? 'bg-accent-foreground/10 ring-2 ring-inset ring-accent-foreground/35'
      : dropTargetState === 'available'
        ? 'bg-accent-foreground/[0.04] ring-1 ring-inset ring-accent-foreground/20'
        : dropTargetState === 'unavailable'
          ? 'opacity-60'
          : '';

  return (
    <motion.section
      ref={setRefs}
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
      aria-disabled={isDragging && !isDropTarget ? true : undefined}
      data-session-board-column={column}
      data-session-board-drop-target={dropTargetState}
      className={`relative min-w-0 motion-safe:transition-[background-color,box-shadow,opacity] md:flex md:min-h-0 md:flex-col ${dropClasses}`}
    >
      <header
        data-session-board-column-header={column}
        className={`mb-2 flex cursor-default items-center justify-between gap-2 px-2 py-1.5 md:sticky md:top-0 md:z-10 md:shrink-0 ${COLUMN_HEADER_CLASSES[column] ?? ''}`}
      >
        <h2
          id={`session-board-${column}`}
          className="text-sm font-medium capitalize"
        >
          {label}
        </h2>
        <span className="text-xs text-current/70">{count}</span>
      </header>
      <div
        data-session-board-card-list={column}
        className="divide-y-2 divide-background bg-card md:min-h-0 md:flex-1 md:overflow-y-auto md:scroll-thin"
      >
        {children}
        {count === 0 && isDropTarget ? (
          <div className="flex min-h-20 items-center justify-center border border-dashed border-foreground/20 px-4 text-center text-xs text-muted-foreground">
            Drop here to mark as {label}
          </div>
        ) : null}
      </div>
    </motion.section>
  );
});

export function SessionBoardCard({
  sessionId,
  column,
  title,
  canManage = false,
  children,
}: {
  sessionId: string;
  column: SessionBoardColumnStatus;
  title: string;
  canManage?: boolean;
  children: ReactNode;
}) {
  const reducedMotion = useReducedMotion() ?? false;
  const registry = useContext(SessionBoardCardRegistryContext);
  const dnd = useContext(SessionBoardDndContext);
  const [isFlying, setIsFlying] = useState(false);
  const dragData = useRef<SessionBoardDragData>({
    column,
    canManage,
    title,
  });
  if (dragData.current.column !== column) {
    dragData.current.keyboardColumn = undefined;
  }
  dragData.current.column = column;
  dragData.current.canManage = canManage;
  dragData.current.title = title;
  const draggable = useDraggable({
    id: sessionId,
    data: dragData.current,
    disabled: !canManage || dnd?.statusMutationPending === true,
  });

  useLayoutEffect(() => {
    const moved = registry?.register(sessionId, column) ?? false;
    const announcedMove = consumeSessionBoardMove(sessionId, column);
    if ((moved || announcedMove) && !reducedMotion) setIsFlying(true);

    return () => registry?.unregister(sessionId, column);
  }, [column, reducedMotion, registry, sessionId]);

  const dragTransform = draggable.transform
    ? `translate3d(${draggable.transform.x}px, ${draggable.transform.y}px, 0)`
    : undefined;
  const isDragging = draggable.isDragging;
  const setDragNodeRef = useCallback(
    (node: HTMLElement | null) => {
      draggable.setNodeRef(node);
      draggable.setActivatorNodeRef(node);
    },
    [draggable],
  );
  const dragListeners = Object.fromEntries(
    Object.entries(draggable.listeners ?? {}).map(([eventName, listener]) => [
      eventName,
      (event: SyntheticEvent) => {
        if (isInteractiveDragTarget(event.target, event.currentTarget)) return;
        listener(event as never);
      },
    ]),
  ) as typeof draggable.listeners;

  return (
    <motion.div
      layout="position"
      layoutId={`session-board-card-${sessionId}`}
      initial={false}
      data-session-board-card-id={sessionId}
      data-session-board-layout-id={`session-board-card-${sessionId}`}
      data-session-board-moving={isFlying ? 'true' : 'false'}
      data-session-board-dragging={isDragging ? 'true' : 'false'}
      className={
        isFlying || isDragging ? 'relative z-30 bg-card' : 'relative bg-card'
      }
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
        <div
          ref={setDragNodeRef}
          style={{ transform: dragTransform }}
          className={`relative w-full ${canManage ? 'cursor-grab active:cursor-grabbing' : ''}`}
          {...(canManage ? draggable.attributes : {})}
          {...(canManage ? dragListeners : {})}
          role={canManage ? 'group' : undefined}
          aria-label={canManage ? `Move ${title} to another status` : undefined}
          aria-pressed={undefined}
          title={canManage ? 'Drag to change session status' : undefined}
          data-session-board-drag-activator={canManage ? true : undefined}
        >
          {children}
        </div>
      </motion.div>
    </motion.div>
  );
}
