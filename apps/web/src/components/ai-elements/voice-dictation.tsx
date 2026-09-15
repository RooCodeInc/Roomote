'use client';

import { cn } from '@/lib/utils';

import { BasicTooltip, Mic } from '@/components/system';

import { PromptInputButton } from './prompt-input';

interface VoiceDictationButtonProps {
  /** Whether recording is active. */
  isRecording: boolean;
  /** Whether the Web Speech API is supported by this browser. */
  isSupported: boolean;
  /** Toggle recording on/off. */
  onClick: () => void;
  /** Whether the button is disabled (e.g. input not connected). */
  disabled?: boolean;
}

export const VoiceDictationButton = ({
  isRecording,
  isSupported,
  onClick,
  disabled,
}: VoiceDictationButtonProps) => {
  if (!isSupported) return null;

  return (
    <BasicTooltip content={isRecording ? 'Stop recording' : 'Voice input'}>
      <PromptInputButton
        aria-label={isRecording ? 'Stop recording' : 'Voice input'}
        onClick={onClick}
        disabled={disabled}
        className={cn(
          'rounded-full transition-colors',
          isRecording && 'bg-primary/10 text-primary hover:bg-primary/20',
        )}
      >
        {isRecording ? (
          <span className="relative flex items-center justify-center">
            <span className="absolute inline-flex size-6 animate-ping rounded-full bg-primary opacity-20" />
            <Mic className="relative size-4" />
          </span>
        ) : (
          <Mic className="size-4" />
        )}
      </PromptInputButton>
    </BasicTooltip>
  );
};
