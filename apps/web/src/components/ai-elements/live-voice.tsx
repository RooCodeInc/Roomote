'use client';

import { cn } from '@/lib/utils';

import { AudioLines, BasicTooltip } from '@/components/system';

import { PromptInputButton } from './prompt-input';

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
