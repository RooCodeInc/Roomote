import {
  SESSION_MANUAL_STATUSES,
  type SessionBoardColumn,
  type SessionManualStatus,
} from '@roomote/types';
import {
  KeyboardCode,
  type KeyboardCoordinateGetter,
  type UniqueIdentifier,
} from '@dnd-kit/core';

export type SessionBoardDragData = {
  column: SessionBoardColumn;
  canManage: boolean;
  title: string;
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
  sourceColumn: SessionBoardColumn,
  targetColumn: UniqueIdentifier | null | undefined,
  canManage: boolean,
): targetColumn is SessionManualStatus {
  const targetStatus = getSessionBoardDropStatus(targetColumn);
  return canManage && targetStatus !== null && targetStatus !== sourceColumn;
}

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

  const currentColumn =
    getSessionBoardDropStatus(context.over?.id) ?? data.column;
  const targetColumn = getSessionBoardKeyboardTarget(currentColumn, event.code);
  if (!targetColumn) return;

  const targetRect = context.droppableRects.get(targetColumn);
  if (!targetRect) return;

  return {
    x: targetRect.left + targetRect.width / 2,
    y: targetRect.top + targetRect.height / 2,
  };
};
