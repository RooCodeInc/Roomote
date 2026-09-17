import { useState, type ReactNode } from 'react';
import { BasicTooltip, SendHorizontal } from '@/components/system';

import {
  type PromptInputMessage,
  PromptInput as PromptInputRoot,
  PromptInputBody,
  PromptInputTextarea,
  PromptInputFooter,
  PromptInputTools,
  PromptInputSubmit,
  PromptInputActionMenu,
  PromptInputActionMenuTrigger,
  PromptInputActionMenuContent,
  PromptInputActionAddAttachments,
  PromptInputHeader,
  Attachments,
  AttachmentInfo,
  Attachment,
  AttachmentPreview,
  AttachmentRemove,
  LiveVoiceButton,
  VoiceDictationButton,
  usePromptInputAttachments,
} from '@/components/ai-elements';

import { useVoiceDictation } from '@/hooks/useVoiceDictation';
import { useGhostSuggestion } from '@/hooks/useGhostSuggestion';
import { ROOMOTE_FILE_ATTACHMENT_ACCEPT } from '@/lib/prompt-attachments';
import { cn } from '@/lib/utils';
import type {
  SelectedSessionContext,
  useSessionContextMentions,
} from './useSessionContextMentions';

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function SubmitButton({
  isBusy,
  disabledReason,
  icon,
  submitWithMetaKey,
}: {
  isBusy: boolean;
  disabledReason?: string;
  icon?: ReactNode;
  submitWithMetaKey: boolean;
}) {
  const isDisabled = isBusy || Boolean(disabledReason);
  const button = (
    <PromptInputSubmit
      disabled={isDisabled}
      variant="default"
      size="sm"
      className="group size-8 overflow-clip"
      tooltip={submitWithMetaKey ? 'Send (Cmd/Ctrl + Enter)' : 'Send (Enter)'}
    >
      {icon ?? (
        <SendHorizontal className="fill-background group-[:not(:disabled):hover]:animate-fly-through" />
      )}
    </PromptInputSubmit>
  );

  if (!disabledReason) {
    return button;
  }

  return (
    <BasicTooltip content={disabledReason}>
      <span>{button}</span>
    </BasicTooltip>
  );
}

function AttachmentsDisplay() {
  const attachments = usePromptInputAttachments();

  if (attachments.files.length === 0) {
    return null;
  }

  return (
    <PromptInputHeader>
      <Attachments variant="inline">
        {attachments.files.map((attachment) => (
          <Attachment
            className="max-w-full"
            data={attachment}
            key={attachment.id}
            onRemove={() => attachments.remove(attachment.id)}
          >
            <AttachmentPreview />
            <AttachmentInfo />
            <AttachmentRemove />
          </Attachment>
        ))}
      </Attachments>
    </PromptInputHeader>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

type TaskPromptInputProps = {
  isBusy: boolean;
  promptText: string;
  onPromptTextChange: (text: string) => void;
  onSubmit: (
    message: PromptInputMessage & {
      integrationIds?: string[];
      sessionContext?: SelectedSessionContext;
    },
  ) => Promise<void> | void;
  placeholder: string;
  /** Optional empty-composer suggestion accepted with Tab. */
  promptSuggestion?: string;
  onPromptFocusChange?: (focused: boolean) => void;
  /** React key forwarded to the PromptInputRoot (useful for resetting state). */
  promptKey?: string;
  autoFocus?: boolean;
  /** Dynamic max-height (in px) for the textarea. When omitted the textarea
   *  falls back to a CSS-based max-height. */
  textareaMaxHeight?: number;
  /** Controls the one-time enter animation on the outer prompt container. */
  animateContainer?: boolean;
  /** Optional content rendered inside the prompt box, below the input. */
  suggestion?: ReactNode;
  /** Optional controls rendered after the attachment action. */
  tools?: ReactNode;
  /** Optional reason that disables the submit button and explains why. */
  submitDisabledReason?: string;
  /** When true, submit on Cmd/Ctrl+Enter instead of plain Enter. */
  submitWithMetaKey?: boolean;
  submitIcon?: ReactNode;
  surface?: 'default' | 'embedded';
  /**
   * Live voice conversation toggle, shown only when the deployment has
   * voice configured. Distinct from dictation: it opens a spoken
   * conversation rather than filling the textarea.
   */
  voice?: TaskPromptVoiceControls;
  contextMentions?: ReturnType<typeof useSessionContextMentions>;
};

type TaskPromptVoiceControls = {
  /** Whether a voice conversation is currently running or connecting. */
  active: boolean;
  onToggle: () => void;
};

export function TaskPromptInput({
  isBusy,
  promptText,
  onPromptTextChange,
  onSubmit,
  placeholder,
  promptSuggestion,
  onPromptFocusChange,
  promptKey,
  autoFocus,
  textareaMaxHeight,
  animateContainer = true,
  suggestion,
  tools,
  submitDisabledReason,
  submitWithMetaKey = true,
  submitIcon,
  surface = 'default',
  voice,
  contextMentions,
}: TaskPromptInputProps) {
  const [isTextareaFocused, setIsTextareaFocused] = useState(false);
  const voiceDictation = useVoiceDictation({
    onTranscript: (text) => onPromptTextChange(text),
    getPrefix: () => promptText,
    disabled: isBusy || Boolean(voice?.active),
  });
  const handleVoiceToggle = () => {
    if (!voice?.active) voiceDictation.stop();
    voice?.onToggle();
  };
  const {
    ghostSuggestion,
    suggestionHintId,
    acceptGhostSuggestion,
    handleSuggestionKeyDown,
  } = useGhostSuggestion({
    suggestion: promptSuggestion?.trim() || null,
    active: !promptText && !isBusy,
    surface: 'home',
    onAccept: onPromptTextChange,
  });

  return (
    <div
      className={cn(
        'flex flex-col gap-2',
        surface === 'default' &&
          'border rounded-lg p-2 bg-card border-input outline-0 outline-offset-[-2px] outline-accent-foreground transition-[outline-width] has-[textarea:focus]:outline-2',
        animateContainer &&
          surface === 'default' &&
          'animate-[enter-down_1s_1_200ms_backwards]',
      )}
    >
      <PromptInputRoot
        key={promptKey}
        onSubmit={(message) => {
          const integrationIds =
            contextMentions?.getSelectedIntegrationIds(message.text) ?? [];
          const sessionContext = contextMentions?.getSelectedSessionContext(
            message.text,
          );
          return onSubmit({
            ...message,
            ...(integrationIds.length > 0 ? { integrationIds } : {}),
            ...(sessionContext ? { sessionContext } : {}),
          });
        }}
        clearOnSubmit={false}
        accept={ROOMOTE_FILE_ATTACHMENT_ACCEPT}
        multiple
      >
        <AttachmentsDisplay />
        <PromptInputBody>
          {contextMentions?.suggestions}
          <div className="flex items-start">
            <PromptInputTextarea
              ref={contextMentions?.textareaRef}
              autoFocus={autoFocus}
              placeholder={ghostSuggestion ?? placeholder}
              disabled={isBusy}
              className={cn(
                'min-w-0 flex-1',
                surface === 'default' && 'min-h-30',
              )}
              style={
                textareaMaxHeight != null
                  ? { maxHeight: textareaMaxHeight }
                  : undefined
              }
              value={promptText}
              submitWithMetaKey={submitWithMetaKey}
              onChange={(event) => {
                if (contextMentions) {
                  contextMentions.handleValueChange(
                    event.target.value,
                    event.target.selectionStart,
                  );
                } else {
                  onPromptTextChange(event.target.value);
                }
              }}
              onSelect={(event) =>
                contextMentions?.handleCursorChange(
                  event.currentTarget.selectionStart,
                )
              }
              onClick={(event) =>
                contextMentions?.handleCursorChange(
                  event.currentTarget.selectionStart,
                )
              }
              onFocus={() => {
                setIsTextareaFocused(true);
                contextMentions?.handleFocus();
                onPromptFocusChange?.(true);
              }}
              onBlur={() => {
                setIsTextareaFocused(false);
                contextMentions?.handleBlur();
                onPromptFocusChange?.(false);
              }}
              onKeyDown={(event) => {
                if (contextMentions?.handleKeyDown(event)) return;
                handleSuggestionKeyDown(event);
              }}
              aria-describedby={ghostSuggestion ? suggestionHintId : undefined}
              {...contextMentions?.inputProps}
            />
            {ghostSuggestion ? (
              <>
                <span id={suggestionHintId} className="sr-only">
                  Suggested task: {ghostSuggestion}. Press Tab to accept or
                  Escape to dismiss.
                </span>
                {isTextareaFocused ? (
                  <button
                    type="button"
                    aria-label="Insert suggested task"
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={acceptGhostSuggestion}
                    className="mt-4 mr-4 shrink-0 whitespace-nowrap rounded border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground/70 transition-colors hover:bg-muted hover:text-muted-foreground"
                  >
                    Tab to accept
                  </button>
                ) : null}
              </>
            ) : null}
          </div>
        </PromptInputBody>
        <PromptInputFooter
          className={surface === 'default' ? 'p-0' : 'pt-0 pb-4 px-4'}
        >
          <PromptInputTools>
            <PromptInputActionMenu>
              <PromptInputActionMenuTrigger />
              <PromptInputActionMenuContent>
                <PromptInputActionAddAttachments />
              </PromptInputActionMenuContent>
            </PromptInputActionMenu>
            {tools}
          </PromptInputTools>
          <div className="flex items-center gap-1">
            {voice ? (
              <LiveVoiceButton
                active={voice.active}
                onClick={handleVoiceToggle}
                disabled={isBusy && !voice.active}
              />
            ) : null}
            <VoiceDictationButton
              isRecording={voiceDictation.isRecording}
              isSupported={voiceDictation.isSupported}
              onClick={voiceDictation.toggle}
              disabled={isBusy || Boolean(voice?.active)}
            />
            <div
              className={`transition-opacity ${promptText.trim().length > 0 ? 'opacity-100' : 'opacity-50'}`}
            >
              <SubmitButton
                isBusy={isBusy}
                disabledReason={submitDisabledReason}
                icon={submitIcon}
                submitWithMetaKey={submitWithMetaKey}
              />
            </div>
          </div>
        </PromptInputFooter>
      </PromptInputRoot>
      {suggestion}
    </div>
  );
}
