import { Phone, PhoneOff } from 'lucide-react';
import { parseAcpVoiceCallPayload } from '@roomote/types';

import type { AcpUiMessage } from './types';

interface AcpVoiceCallMessageProps {
  msg: AcpUiMessage;
}

function formatCallDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

/**
 * Centered divider marking where a voice call on the Session started or
 * ended. The spoken turns between two markers are the call's transcript.
 */
export function AcpVoiceCallMessage({ msg }: AcpVoiceCallMessageProps) {
  const payload = parseAcpVoiceCallPayload(
    (msg.data as Record<string, unknown>) ?? null,
  );
  if (!payload) return null;

  const ended = payload.phase === 'ended';
  const Icon = ended ? PhoneOff : Phone;
  const label = ended
    ? payload.durationMs !== undefined
      ? `Call ended · ${formatCallDuration(payload.durationMs)}`
      : 'Call ended'
    : 'Call started';

  return (
    <div
      className="my-4 flex items-center gap-3"
      data-testid="voice-call-marker"
      title={new Date(msg.ts).toLocaleString()}
    >
      <div className="h-px flex-1 bg-border" aria-hidden="true" />
      <div className="flex items-center gap-1.5 rounded-full border border-border/70 bg-muted/40 px-3 py-1 text-xs text-muted-foreground">
        <Icon className="size-3.5 shrink-0" aria-hidden="true" />
        <span>{label}</span>
      </div>
      <div className="h-px flex-1 bg-border" aria-hidden="true" />
    </div>
  );
}
