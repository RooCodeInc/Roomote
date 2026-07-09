import { CircleStop } from 'lucide-react';
import { parseAcpTaskCancelledPayload } from '@roomote/types';

import type { AcpUiMessage } from './types';

interface AcpTaskCancelledMessageProps {
  msg: AcpUiMessage;
}

/**
 * Centered divider marking the point where a user explicitly stopped the
 * task. Renders from the persisted `task_cancelled` envelope, so it appears
 * identically in the live view and reloaded history.
 */
export function AcpTaskCancelledMessage({ msg }: AcpTaskCancelledMessageProps) {
  const payload = parseAcpTaskCancelledPayload(
    (msg.data as Record<string, unknown>) ?? null,
  );
  const label = payload?.cancelledByName
    ? `Stopped by ${payload.cancelledByName}`
    : 'Stopped';

  return (
    <div
      className="my-4 flex items-center gap-3"
      data-testid="task-cancelled-marker"
      title={new Date(msg.ts).toLocaleString()}
    >
      <div className="h-px flex-1 bg-border" aria-hidden="true" />
      <div className="flex items-center gap-1.5 rounded-full border border-border/70 bg-muted/40 px-3 py-1 text-xs text-muted-foreground">
        <CircleStop className="size-3.5 shrink-0" aria-hidden="true" />
        <span>{label}</span>
      </div>
      <div className="h-px flex-1 bg-border" aria-hidden="true" />
    </div>
  );
}
