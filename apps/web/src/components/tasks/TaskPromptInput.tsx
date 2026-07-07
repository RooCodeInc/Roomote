import type { ReactNode } from 'react';
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
  VoiceDictationButton,
  usePromptInputAttachments,
} from '@/components/ai-elements';

import { useVoiceDictation } from '@/hooks/useVoiceDictation';
import { ROOMOTE_FILE_ATTACHMENT_ACCEPT } from '@/lib/prompt-attachments';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function SubmitButton({
  isBusy,
  disabledReason,
}: {
  isBusy: boolean;
  disabledReason?: string;
}) {
  const isDisabled = isBusy || Boolean(disabledReason);
  const button = (
    <PromptInputSubmit
      disabled={isDisabled}
      variant="default"
      size="sm"
      className="group size-8 overflow-clip"
    >
      <SendHorizontal className="fill-background group-[:not(:disabled):hover]:animate-fly-through" />
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
  onSubmit: (message: PromptInputMessage) => Promise<void> | void;
  placeholder: string;
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
  /** Optional reason that disables the submit button and explains why. */
  submitDisabledReason?: string;
  /** When true, submit on Cmd/Ctrl+Enter instead of plain Enter. */
  submitWithMetaKey?: boolean;
};

export function TaskPromptInput({
  isBusy,
  promptText,
  onPromptTextChange,
  onSubmit,
  placeholder,
  promptKey,
  autoFocus,
  textareaMaxHeight,
  animateContainer = true,
  suggestion,
  submitDisabledReason,
  submitWithMetaKey = true,
}: TaskPromptInputProps) {
  const voiceDictation = useVoiceDictation({
    onTranscript: (text) => onPromptTextChange(text),
    getPrefix: () => promptText,
    disabled: isBusy,
  });

  return (
    <div
      className={cn(
        'flex flex-col gap-2 border rounded-lg p-2 bg-card border-input focus-within:border-accent-bright-foreground',
        animateContainer && 'animate-[enter-down_1s_1_200ms_backwards]',
      )}
    >
      <PromptInputRoot
        key={promptKey}
        onSubmit={onSubmit}
        clearOnSubmit={false}
        accept={ROOMOTE_FILE_ATTACHMENT_ACCEPT}
        multiple
      >
        <AttachmentsDisplay />
        <PromptInputBody>
          <PromptInputTextarea
            autoFocus={autoFocus}
            placeholder={placeholder}
            disabled={isBusy}
            className="min-h-30"
            style={
              textareaMaxHeight != null
                ? { maxHeight: textareaMaxHeight }
                : undefined
            }
            value={promptText}
            submitWithMetaKey={submitWithMetaKey}
            onChange={(e) => onPromptTextChange(e.target.value)}
          />
        </PromptInputBody>
        <PromptInputFooter className="p-0">
          <PromptInputTools>
            <PromptInputActionMenu>
              <PromptInputActionMenuTrigger />
              <PromptInputActionMenuContent>
                <PromptInputActionAddAttachments />
              </PromptInputActionMenuContent>
            </PromptInputActionMenu>
          </PromptInputTools>
          <div className="flex items-center gap-1">
            <VoiceDictationButton
              isRecording={voiceDictation.isRecording}
              isSupported={voiceDictation.isSupported}
              onClick={voiceDictation.toggle}
              disabled={isBusy}
            />
            <div
              className={`transition-opacity ${promptText.trim().length > 0 ? 'opacity-100' : 'opacity-50'}`}
            >
              <SubmitButton
                isBusy={isBusy}
                disabledReason={submitDisabledReason}
              />
            </div>
          </div>
        </PromptInputFooter>
      </PromptInputRoot>
      {suggestion}
    </div>
  );
}
