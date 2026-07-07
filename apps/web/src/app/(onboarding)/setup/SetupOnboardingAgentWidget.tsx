'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { toast } from 'sonner';

import { Button, Check, GripVertical, Maximize2 } from '@/components/system';
import { TaskStatusIndicator } from '@/components/sandbox';
import {
  EnvironmentDefinitionAgentTaskPanel,
  useEnvironmentDefinitionAgentState,
} from '@/components/settings/environments/EnvironmentDefinitionAgentTask';

type WidgetPosition = {
  x: number;
  y: number;
};

type DragState = {
  pointerId: number;
  startX: number;
  startY: number;
  originX: number;
  originY: number;
} | null;

const WIDGET_MARGIN = 16;

function clampPosition(
  position: WidgetPosition,
  element: HTMLElement | null,
): WidgetPosition {
  if (typeof window === 'undefined' || !element) {
    return position;
  }

  const width = element.offsetWidth;
  const height = element.offsetHeight;

  return {
    x: Math.min(
      Math.max(position.x, WIDGET_MARGIN),
      Math.max(WIDGET_MARGIN, window.innerWidth - width - WIDGET_MARGIN),
    ),
    y: Math.min(
      Math.max(position.y, WIDGET_MARGIN),
      Math.max(WIDGET_MARGIN, window.innerHeight - height - WIDGET_MARGIN),
    ),
  };
}

export function SetupOnboardingAgentWidget({
  taskId,
  hidden,
  expanded,
  position,
  onExpandedChange,
  onPositionChange,
  onOpenStep,
  onFinish,
}: {
  taskId: string;
  hidden: boolean;
  expanded: boolean;
  position: WidgetPosition;
  onExpandedChange: (expanded: boolean) => void;
  onPositionChange: (position: WidgetPosition) => void;
  onOpenStep: () => void;
  onFinish: () => void;
}) {
  const { session, succeeded, failed, matchingEnvironment } =
    useEnvironmentDefinitionAgentState({
      taskId,
      mode: 'create',
    });
  const widgetRef = useRef<HTMLDivElement>(null);
  const dragStateRef = useRef<DragState>(null);
  const positionRef = useRef(position);
  const onPositionChangeRef = useRef(onPositionChange);
  positionRef.current = position;
  onPositionChangeRef.current = onPositionChange;

  const statusCopy = useMemo(() => {
    if (succeeded) {
      return 'Your first environment is ready. Finish setup when you are ready to continue.';
    }

    if (failed) {
      return 'The onboarding agent needs attention before setup can finish.';
    }

    return 'Understanding your codebase and getting your environment ready.';
  }, [failed, succeeded]);

  const commitClampedPosition = useCallback(() => {
    const current = positionRef.current;
    const nextPosition = clampPosition(current, widgetRef.current);

    if (nextPosition.x !== current.x || nextPosition.y !== current.y) {
      onPositionChangeRef.current(nextPosition);
    }
  }, []);

  useEffect(() => {
    if (hidden) {
      return;
    }

    commitClampedPosition();

    const handleResize = () => {
      commitClampedPosition();
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [commitClampedPosition, expanded, hidden]);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const dragState = dragStateRef.current;
      if (!dragState || event.pointerId !== dragState.pointerId) {
        return;
      }

      const nextPosition = clampPosition(
        {
          x: dragState.originX + (event.clientX - dragState.startX),
          y: dragState.originY - (event.clientY - dragState.startY),
        },
        widgetRef.current,
      );

      onPositionChangeRef.current(nextPosition);
    };

    const handlePointerUp = (event: PointerEvent) => {
      if (
        dragStateRef.current &&
        event.pointerId === dragStateRef.current.pointerId
      ) {
        dragStateRef.current = null;
        commitClampedPosition();
      }
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);

    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, [commitClampedPosition]);

  if (hidden) {
    return null;
  }

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('button')) {
      return;
    }

    dragStateRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: position.x,
      originY: position.y,
    };
  };

  const handleFinish = () => {
    onExpandedChange(false);
    const environmentName = matchingEnvironment?.name ?? 'Your environment';
    toast.success(`${environmentName} is now configured`);
    onFinish();
  };

  return (
    <div
      ref={widgetRef}
      className={`fixed z-40 ${expanded ? 'w-2xl max-w-[calc(100vw-2rem)]' : 'w-[min(24rem,calc(100vw-2rem))]'}`}
      style={{
        left: position.x,
        bottom: position.y,
      }}
    >
      <div className="overflow-hidden rounded-xl border bg-card shadow-lg">
        <div
          className="flex cursor-grab items-center justify-between gap-3 border-b px-4 py-3 text-sm active:cursor-grabbing"
          onPointerDown={handlePointerDown}
        >
          <div className="flex items-center gap-2">
            <GripVertical className="size-4 text-muted-foreground" />
            <span className="font-semibold">Onboarding agent</span>
          </div>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            aria-label={
              expanded ? 'Collapse onboarding agent' : 'Expand onboarding agent'
            }
            onClick={() => onExpandedChange(!expanded)}
          >
            <Maximize2 />
          </Button>
        </div>

        {expanded ? (
          <div className="space-y-3 p-4">
            <EnvironmentDefinitionAgentTaskPanel
              title="Onboarding agent"
              session={session}
              className="h-[min(70vh,42rem)] max-h-[70vh]"
              showHeader={false}
            />
            {succeeded ? (
              <div className="flex justify-end">
                <Button type="button" size="sm" onClick={handleFinish}>
                  Finish
                </Button>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="space-y-4 px-4 pt-2">
            <div className="flex gap-2 items-start ml-1">
              <TaskStatusIndicator
                status={session.cloudJob?.status}
                phase={session.cloudJob?.taskPhase}
                compact={true}
                className="relative top-1.5"
              />
              <p className="text-sm text-muted-foreground">{statusCopy}</p>
            </div>
            <div className="flex items-center gap-2 pl-4">
              {succeeded ? (
                <Button type="button" size="sm" onClick={handleFinish}>
                  <Check />
                  Finish
                </Button>
              ) : failed ? (
                <Button type="button" size="sm" onClick={onOpenStep}>
                  <Maximize2 />
                  Open
                </Button>
              ) : null}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
