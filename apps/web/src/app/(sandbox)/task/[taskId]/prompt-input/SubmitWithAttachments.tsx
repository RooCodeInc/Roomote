import {
  PromptInputSubmit,
  usePromptInputAttachments,
} from '@/components/ai-elements';

export function SubmitWithAttachments({
  isTaskRunning,
  connected,
  sending,
  prompt,
  handleCancel,
}: {
  isTaskRunning: boolean;
  connected: boolean;
  sending: boolean;
  prompt: string;
  handleCancel: () => void;
}) {
  const attachments = usePromptInputAttachments();
  const hasAttachments = attachments.files.length > 0;
  const hasQueuedPrompt = Boolean(prompt.trim()) || hasAttachments;
  const showStopButton = isTaskRunning && !hasQueuedPrompt;

  return (
    <PromptInputSubmit
      status={showStopButton ? 'streaming' : undefined}
      onStop={showStopButton ? handleCancel : undefined}
      disabled={
        !showStopButton &&
        (!connected || sending || (!prompt.trim() && !hasAttachments))
      }
    />
  );
}
