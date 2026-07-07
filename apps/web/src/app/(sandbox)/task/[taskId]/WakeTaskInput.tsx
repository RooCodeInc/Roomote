'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import type { PromptInputMessage } from '@/components/ai-elements';
import { TaskPromptInput } from '@/components/tasks';
import { useRestoreCloudJobSnapshot } from '@/hooks/snapshots';
import { preparePromptAttachments } from '@/lib/prompt-attachments';
import type { CloudJobDetail } from '@/lib/server';

import { useOptimisticPromptSubmission } from './prompt-input/useOptimisticPromptSubmission';

interface WakeTaskInputProps {
  cloudJob: Pick<CloudJobDetail, 'id' | 'snapshotId' | 'taskId'>;
  initialPrompt?: string;
}

export function WakeTaskInput({
  cloudJob,
  initialPrompt = '',
}: WakeTaskInputProps) {
  const {
    rollbackOptimisticPromptSubmission,
    startOptimisticPromptSubmission,
  } = useOptimisticPromptSubmission();
  const [promptText, setPromptText] = useState(initialPrompt);
  const [sending, setSending] = useState(false);

  const restore = useRestoreCloudJobSnapshot({
    onSuccess: () => setPromptText(''),
  });
  const isBusy = sending || restore.isPending;

  useEffect(() => {
    setPromptText(initialPrompt);
  }, [cloudJob.id, initialPrompt]);

  const handleSubmit = async (message: PromptInputMessage) => {
    if (!cloudJob.snapshotId || isBusy) {
      return;
    }

    setSending(true);
    let optimisticClientMessageId: string | null = null;

    try {
      const rawPrompt = message.text.trim();

      if (rawPrompt.length === 0 && (message.files?.length ?? 0) === 0) {
        await restore.mutateAsync({
          sourceSnapshotId: cloudJob.snapshotId,
          sourceCloudJobId: cloudJob.id,
          resumePrompt: '',
        });

        return;
      }

      const preparedPrompt = await preparePromptAttachments({
        text: rawPrompt,
        attachments: message.files,
      });
      const resumePrompt = preparedPrompt.text.trim();

      if (resumePrompt.length === 0) {
        if ((message.files?.length ?? 0) > 0) {
          toast.error('Add a message to send while the task wakes up.');
        }

        return;
      }

      const { clientMessageId } = startOptimisticPromptSubmission({
        taskId: cloudJob.taskId,
        prompt: resumePrompt,
        images: preparedPrompt.images,
        location: 'transcript',
      });
      optimisticClientMessageId = clientMessageId;

      const result = await restore.mutateAsync({
        sourceSnapshotId: cloudJob.snapshotId,
        sourceCloudJobId: cloudJob.id,
        resumePrompt,
        clientMessageId,
        ...(preparedPrompt.images?.length
          ? { resumePromptImages: preparedPrompt.images }
          : {}),
      });

      if (!result.success) {
        rollbackOptimisticPromptSubmission({
          taskId: cloudJob.taskId,
          clientMessageId,
          location: 'transcript',
        });
      }
    } catch (error) {
      if (optimisticClientMessageId) {
        rollbackOptimisticPromptSubmission({
          taskId: cloudJob.taskId,
          clientMessageId: optimisticClientMessageId,
          location: 'transcript',
        });
      }

      toast.error(
        error instanceof Error
          ? error.message
          : 'Failed to prepare the wake-up message.',
      );
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="border-t">
      <div className="mx-auto w-full max-w-4xl px-4 pt-4 pb-5">
        <TaskPromptInput
          isBusy={isBusy}
          promptText={promptText}
          onPromptTextChange={setPromptText}
          onSubmit={handleSubmit}
          placeholder="Wake up Roomote with this message"
          animateContainer={false}
          submitWithMetaKey={false}
        />
      </div>
    </div>
  );
}
