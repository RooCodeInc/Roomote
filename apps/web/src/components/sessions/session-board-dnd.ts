import {
  SESSION_MANUAL_STATUSES,
  type SessionBoardColumn,
  type SessionManualStatus,
} from '@roomote/types';
import {
  closestCenter,
  KeyboardCode,
  pointerWithin,
  type CollisionDetection,
  type KeyboardCoordinateGetter,
  type UniqueIdentifier,
} from '@dnd-kit/core';

export type SessionBoardDragData = {
  column: SessionBoardColumn;
  canManage: boolean;
  title: string;
  keyboardColumn?: SessionBoardColumn;
};

export function getSessionBoardDropStatus(
  value: UniqueIdentifier | null | undefined,
): SessionManualStatus | null {
  return typeof value === 'string' &&
    (SESSION_MANUAL_STATUSES as readonly string[]).includes(value)
    ? (value as SessionManualStatus)
    : null;
}

export function canDropSessionBoardCard(
  _sourceColumn: SessionBoardColumn,
  targetColumn: UniqueIdentifier | null | undefined,
  canManage: boolean,
): targetColumn is SessionManualStatus {
  const targetStatus = getSessionBoardDropStatus(targetColumn);
  return canManage && targetStatus !== null;
}

export const sessionBoardCollisionDetection: CollisionDetection = (args) => {
  const pointerCollisions = pointerWithin(args);
  return pointerCollisions.length > 0 ? pointerCollisions : closestCenter(args);
};

export function getSessionBoardKeyboardTarget(
  currentColumn: SessionBoardColumn,
  code: string,
): SessionManualStatus | null {
  const direction =
    code === KeyboardCode.Right || code === KeyboardCode.Down
      ? 1
      : code === KeyboardCode.Left || code === KeyboardCode.Up
        ? -1
        : 0;
  if (direction === 0) return null;

  const sourceIndex = SESSION_MANUAL_STATUSES.indexOf(
    currentColumn as SessionManualStatus,
  );
  const targetIndex =
    sourceIndex === -1 ? (direction > 0 ? 0 : -1) : sourceIndex + direction;

  return SESSION_MANUAL_STATUSES[targetIndex] ?? null;
}

export const sessionBoardKeyboardCoordinates: KeyboardCoordinateGetter = (
  event,
  { active, context },
) => {
  const data = context.draggableNodes.get(active)?.data.current as
    | SessionBoardDragData
    | undefined;
  if (!data) return;

  // DndKit may report the nearest enabled lane before the first keyboard move.
  // Keep the initial source column until an arrow key chooses a target, then
  // continue from that chosen lane instead of the collision-derived `over`.
  const currentColumn = data.keyboardColumn ?? data.column;
  const targetColumn = getSessionBoardKeyboardTarget(currentColumn, event.code);
  if (!targetColumn) return;

  const targetRect = context.droppableRects.get(targetColumn);
  if (!targetRect) return;

  data.keyboardColumn = targetColumn;

  return {
    x: targetRect.left + targetRect.width / 2,
    y: targetRect.top + targetRect.height / 2,
  };
};
