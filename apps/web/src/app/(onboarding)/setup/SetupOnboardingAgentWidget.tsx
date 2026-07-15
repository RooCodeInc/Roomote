'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import Link from 'next/link';
import { toast } from 'sonner';

import { SETTINGS_PATHS } from '@/lib/settings';
import { useRetryEnvironmentVerification } from '@/hooks/environments';
import { Button, Check, GripVertical, Maximize2 } from '@/components/system';
import { TaskStatusIndicator } from '@/components/sandbox';
import { useEnvironmentDefinitionAgentState } from '@/components/settings/environments/EnvironmentDefinitionAgentTask';

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
  const {
    session,
    succeeded,
    failed,
    matchingEnvironment,
    verificationPending,
    verificationSucceeded,
    verificationFailed,
  } = useEnvironmentDefinitionAgentState({
    taskId,
    mode: 'create',
  });
  const widgetRef = useRef<HTMLDivElement>(null);
  const dragStateRef = useRef<DragState>(null);
  const positionRef = useRef(position);
  const onPositionChangeRef = useRef(onPositionChange);
  positionRef.current = position;
  onPositionChangeRef.current = onPositionChange;

  const retryVerification = useRetryEnvironmentVerification();
  const environmentId = matchingEnvironment?.id ?? null;
  const verificationTaskId = matchingEnvironment?.verificationTaskId ?? null;
  const showVerificationActions =
    !!matchingEnvironment && (verificationPending || verificationFailed);

  const statusCopy = useMemo(() => {
    if (verificationSucceeded) {
      return 'Your environment is verified and ready to use.';
    }

    if (verificationFailed) {
      return 'Your environment is configured, but Roomote could not verify that it works.';
    }

    if (verificationPending) {
      return 'Your environment is configured. Roomote is checking that it works; you can continue while this finishes.';
    }

    if (succeeded) {
      return 'Your first environment is configured. Finish setup when you are ready to continue.';
    }

    if (failed) {
      return 'The onboarding agent needs attention before setup can finish.';
    }

    return 'Understanding your codebase and getting your environment ready.';
  }, [
    failed,
    succeeded,
    verificationFailed,
    verificationPending,
    verificationSucceeded,
  ]);

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
            <div className="flex gap-2 items-start">
              <TaskStatusIndicator
                status={session.taskRun?.status}
                phase={session.taskRun?.taskPhase}
                lastErrorMessage={session.taskRun?.error}
                compact={true}
                className="relative top-1.5"
              />
              <p className="text-sm text-muted-foreground">{statusCopy}</p>
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <Button size="sm" variant="outline" asChild>
                <Link href={`/task/${taskId}`}>
                  <Maximize2 />
                  View task
                </Link>
              </Button>
              {succeeded ? (
                <Button type="button" size="sm" onClick={handleFinish}>
                  Finish
                </Button>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="space-y-4 px-4 pt-2">
            <div className="flex gap-2 items-start ml-1">
              <TaskStatusIndicator
                status={session.taskRun?.status}
                phase={session.taskRun?.taskPhase}
                lastErrorMessage={session.taskRun?.error}
                compact={true}
                className="relative top-1.5"
              />
              <p className="text-sm text-muted-foreground">{statusCopy}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2 pl-4">
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
              {showVerificationActions ? (
                <>
                  {verificationFailed && environmentId ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={retryVerification.isPending}
                      onClick={() =>
                        retryVerification.mutate({ environmentId })
                      }
                    >
                      Retry verification
                    </Button>
                  ) : null}
                  {environmentId ? (
                    <Button size="sm" variant="ghost" asChild>
                      <Link
                        href={SETTINGS_PATHS.editEnvironment(environmentId)}
                      >
                        Edit environment
                      </Link>
                    </Button>
                  ) : null}
                  {verificationTaskId ? (
                    <Button size="sm" variant="ghost" asChild>
                      <Link href={`/task/${verificationTaskId}`}>
                        View task
                      </Link>
                    </Button>
                  ) : null}
                </>
              ) : null}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
