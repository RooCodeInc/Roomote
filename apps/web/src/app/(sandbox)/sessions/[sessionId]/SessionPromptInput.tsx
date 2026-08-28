'use client';

import { useState } from 'react';

import type { ReasoningEffort } from '@roomote/types';

import { ROOMOTE_FILE_ATTACHMENT_ACCEPT } from '@/lib/prompt-attachments';
import { useVoiceDictation } from '@/hooks/useVoiceDictation';
import {
  type PromptInputMessage,
  PromptInput as PromptInputRoot,
  PromptInputActionAddAttachments,
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuTrigger,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  VoiceDictationButton,
  usePromptInputAttachments,
} from '@/components/ai-elements';
import { BasicTooltip } from '@/components/system';

import { AttachmentsDisplay } from '../../task/[taskId]/prompt-input/AttachmentsDisplay';
import { SessionModelSwitcher } from './SessionModelSwitcher';

export type SessionPromptSubmission = PromptInputMessage & {
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
};

function SessionSubmit({
  sending,
  prompt,
}: {
  sending: boolean;
  prompt: string;
}) {
  const attachments = usePromptInputAttachments();
  const hasAttachments = attachments.files.length > 0;

  return (
    <PromptInputSubmit
      disabled={sending || (!prompt.trim() && !hasAttachments)}
    />
  );
}

/** Session reply composer mirroring the task composer's structure: action
 * menu and model switcher on the left, voice and submit on the right. */
export function SessionPromptInput({
  isBusy,
  onSend,
  initialModel = null,
  initialReasoningEffort = null,
  defaultModelId = null,
  defaultReasoningEffort = null,
}: {
  isBusy: boolean;
  onSend: (submission: SessionPromptSubmission) => Promise<boolean>;
  initialModel?: string | null;
  initialReasoningEffort?: ReasoningEffort | null;
  defaultModelId?: string | null;
  defaultReasoningEffort?: ReasoningEffort | null;
}) {
  const [prompt, setPrompt] = useState('');
  const [resetKey, setResetKey] = useState(0);
  const [model, setModel] = useState(initialModel ?? '');
  const [reasoningEffort, setReasoningEffort] =
    useState<ReasoningEffort | null>(initialReasoningEffort);
  const voiceDictation = useVoiceDictation({
    onTranscript: (text) => setPrompt(text),
    getPrefix: () => prompt,
    disabled: isBusy,
  });

  const handleSubmit = async (message: PromptInputMessage) => {
    // Always send the current picker state: it round-trips the persisted
    // choice and clears it when the picker is reset to the default. The
    // draft and attachments are only cleared once the send succeeds, so a
    // failed reply is not lost.
    const sent = await onSend({
      ...message,
      model: model || null,
      reasoningEffort,
    });
    if (sent) {
      setPrompt('');
      // Remount the root to clear held attachments.
      setResetKey((previous) => previous + 1);
    }
  };

  return (
    <div className="mx-auto w-full max-w-4xl">
      <PromptInputRoot
        key={`composer-${resetKey}`}
        onSubmit={handleSubmit}
        accept={ROOMOTE_FILE_ATTACHMENT_ACCEPT}
        clearOnSubmit={false}
        multiple
      >
        <AttachmentsDisplay />
        <PromptInputBody>
          <PromptInputTextarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="Message agent"
            disabled={isBusy}
          />
        </PromptInputBody>
        <PromptInputFooter className="px-4 pt-0 pb-4">
          <PromptInputTools>
            <PromptInputActionMenu>
              <BasicTooltip content="Add to session">
                <PromptInputActionMenuTrigger
                  aria-label="Add to session"
                  className="hover:bg-secondary"
                />
              </BasicTooltip>
              <PromptInputActionMenuContent>
                <PromptInputActionAddAttachments />
              </PromptInputActionMenuContent>
            </PromptInputActionMenu>
            <SessionModelSwitcher
              model={model}
              onModelChange={setModel}
              reasoningEffort={reasoningEffort}
              onReasoningEffortChange={setReasoningEffort}
              defaultModelId={defaultModelId}
              defaultReasoningEffort={defaultReasoningEffort}
              disabled={isBusy}
            />
          </PromptInputTools>
          <div className="flex items-center gap-2">
            <VoiceDictationButton
              isRecording={voiceDictation.isRecording}
              isSupported={voiceDictation.isSupported}
              onClick={voiceDictation.toggle}
              disabled={isBusy}
            />
            <SessionSubmit sending={isBusy} prompt={prompt} />
          </div>
        </PromptInputFooter>
      </PromptInputRoot>
    </div>
  );
}
