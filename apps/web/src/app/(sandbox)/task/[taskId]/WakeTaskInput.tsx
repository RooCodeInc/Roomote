'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import {
  DEFAULT_MANAGED_DEPLOYMENT_ACCESS,
  getTaskToolInvocation,
  type TaskToolActionId,
} from '@roomote/types';

import type { PromptInputMessage } from '@/components/ai-elements';
import { TaskPromptInput } from '@/components/tasks';
import { Sun } from '@/components/system';
import { useRestoreTaskRunSnapshot } from '@/hooks/snapshots';
import { useAuthorizedUser } from '@/hooks/useUser';
import { getTaskLaunchDisabledReason } from '@/lib/managed-access';
import { preparePromptAttachments } from '@/lib/prompt-attachments';
import type { TaskRunDetail } from '@/lib/server';
import { cn } from '@/lib/utils';

import { useOptimisticPromptSubmission } from './prompt-input/useOptimisticPromptSubmission';
import { TaskModelSwitcher } from './prompt-input/TaskModelSwitcher';
import { TaskToolsMenu } from './sidebar-actions/TaskToolsButton';
import { shouldShowTaskToolsActions } from './sidebar-actions/utils';

interface WakeTaskInputProps {
  taskRun: Pick<TaskRunDetail, 'id' | 'snapshotId' | 'taskId'> &
    Partial<Pick<TaskRunDetail, 'harness' | 'payload' | 'payloadKind'>>;
  initialPrompt?: string;
  embedded?: boolean;
}

export function WakeTaskInput({
  taskRun,
  initialPrompt = '',
  embedded = false,
}: WakeTaskInputProps) {
  const {
    rollbackOptimisticPromptSubmission,
    startOptimisticPromptSubmission,
  } = useOptimisticPromptSubmission();
  const [promptText, setPromptText] = useState(initialPrompt);
  const [sending, setSending] = useState(false);
  const [modelSettingsPending, setModelSettingsPending] = useState(false);
  const { managedAccess = DEFAULT_MANAGED_DEPLOYMENT_ACCESS } =
    useAuthorizedUser();
  const taskLaunchDisabledReason = getTaskLaunchDisabledReason(managedAccess);

  const restore = useRestoreTaskRunSnapshot({
    onSuccess: () => setPromptText(''),
  });
  const isBusy = sending || restore.isPending || modelSettingsPending;

  useEffect(() => {
    setPromptText(initialPrompt);
  }, [taskRun.id, initialPrompt]);

  const handleSubmit = async (message: PromptInputMessage) => {
    if (!taskRun.snapshotId || isBusy || taskLaunchDisabledReason) {
      return;
    }

    setSending(true);
    let optimisticClientMessageId: string | null = null;

    try {
      const rawPrompt = message.text.trim();

      if (rawPrompt.length === 0 && (message.files?.length ?? 0) === 0) {
        await restore.mutateAsync({
          sourceSnapshotId: taskRun.snapshotId,
          sourceRunId: taskRun.id,
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
        taskId: taskRun.taskId,
        prompt: resumePrompt,
        images: preparedPrompt.images,
        location: 'transcript',
      });
      optimisticClientMessageId = clientMessageId;

      const result = await restore.mutateAsync({
        sourceSnapshotId: taskRun.snapshotId,
        sourceRunId: taskRun.id,
        resumePrompt,
        clientMessageId,
        ...(preparedPrompt.images?.length
          ? { resumePromptImages: preparedPrompt.images }
          : {}),
      });

      if (!result.success) {
        rollbackOptimisticPromptSubmission({
          taskId: taskRun.taskId,
          clientMessageId,
          location: 'transcript',
        });
      }
    } catch (error) {
      if (optimisticClientMessageId) {
        rollbackOptimisticPromptSubmission({
          taskId: taskRun.taskId,
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

  const handleTaskToolSelect = (actionId: TaskToolActionId) => {
    void handleSubmit({
      text: getTaskToolInvocation(actionId, taskRun.harness),
      files: [],
    });
  };

  const input = (
    <div
      className={cn(
        'mx-auto w-full max-w-4xl',
        embedded ? '' : 'px-4 pt-4 pb-5',
      )}
    >
      <TaskPromptInput
        isBusy={isBusy}
        promptText={promptText}
        onPromptTextChange={setPromptText}
        onSubmit={handleSubmit}
        placeholder="Wake up Roomote with a message..."
        animateContainer={false}
        submitWithMetaKey={false}
        submitIcon={promptText.trim().length === 0 ? <Sun /> : undefined}
        tools={
          <>
            {shouldShowTaskToolsActions(taskRun.payloadKind) && (
              <TaskToolsMenu
                onSelect={handleTaskToolSelect}
                disabled={isBusy || Boolean(taskLaunchDisabledReason)}
              />
            )}
            {taskRun.harness === 'opencode-server' && (
              <TaskModelSwitcher
                taskRun={taskRun}
                disabled={isBusy}
                onPendingChange={setModelSettingsPending}
              />
            )}
          </>
        }
        surface={embedded ? 'embedded' : 'default'}
        submitDisabledReason={taskLaunchDisabledReason}
      />
    </div>
  );

  return embedded ? input : <div className="border-t">{input}</div>;
}
