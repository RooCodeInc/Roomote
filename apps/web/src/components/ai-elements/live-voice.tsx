'use client';

import { cn } from '@/lib/utils';

import { AudioLines, BasicTooltip, X } from '@/components/system';

import type { LiveVoiceStatus } from '@/hooks/useLiveVoice';
import { PromptInputButton } from './prompt-input';
import { Shimmer } from './shimmer';

interface LiveVoiceButtonProps {
  /** Whether a voice conversation is running. */
  active: boolean;
  /** Toggle the conversation on/off. */
  onClick: () => void;
  disabled?: boolean;
}

/** Composer toggle for the live voice conversation. */
export const LiveVoiceButton = ({
  active,
  onClick,
  disabled,
}: LiveVoiceButtonProps) => {
  return (
    <BasicTooltip
      content={active ? 'End voice conversation' : 'Voice conversation'}
    >
      <PromptInputButton
        aria-label={active ? 'End voice conversation' : 'Voice conversation'}
        onClick={onClick}
        disabled={disabled}
        className={cn(
          'rounded-full transition-colors',
          active && 'bg-primary/10 text-primary hover:bg-primary/20',
        )}
      >
        <AudioLines className="size-4" />
      </PromptInputButton>
    </BasicTooltip>
  );
};

const STATUS_LABELS: Partial<Record<LiveVoiceStatus, string>> = {
  connecting: 'Connecting',
  listening: 'Listening',
  speaking: 'Speaking',
};

interface LiveVoiceStatusBarProps {
  status: LiveVoiceStatus;
  /** In-progress transcription of the current utterance. */
  interimTranscript: string;
  /** True while the agent is composing a reply. */
  thinking: boolean;
  error: string | null;
  onStop: () => void;
}

/** Conversation state strip shown above the composer while voice is active. */
export const LiveVoiceStatusBar = ({
  status,
  interimTranscript,
  thinking,
  error,
  onStop,
}: LiveVoiceStatusBarProps) => {
  const label = thinking
    ? 'Thinking'
    : (STATUS_LABELS[status] ?? STATUS_LABELS.listening);

  return (
    <div className="mx-auto flex w-full max-w-4xl items-center gap-3 px-4 py-2">
      <span className="relative flex size-2 shrink-0">
        <span
          className={cn(
            'absolute inline-flex size-2 animate-ping rounded-full opacity-40',
            status === 'speaking' ? 'bg-primary' : 'bg-red-400',
          )}
        />
        <span
          className={cn(
            'relative inline-flex size-2 rounded-full',
            status === 'speaking' ? 'bg-primary' : 'bg-red-500',
          )}
        />
      </span>
      <div className="min-w-0 flex-1 text-sm">
        {error ? (
          <span className="text-destructive">{error}</span>
        ) : interimTranscript ? (
          <span className="ph-no-capture truncate text-muted-foreground">
            {interimTranscript}
          </span>
        ) : (
          <Shimmer className="font-light" duration={2}>
            {label ?? 'Listening'}
          </Shimmer>
        )}
      </div>
      <button
        type="button"
        onClick={onStop}
        aria-label="End voice conversation"
        className="flex shrink-0 cursor-pointer items-center gap-1 rounded-full px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
      >
        <X className="size-3.5" />
        End
      </button>
    </div>
  );
};
