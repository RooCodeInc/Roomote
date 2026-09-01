'use client';

import { Fragment, memo } from 'react';
import { toast } from 'sonner';

import type { TaskToolActionId } from '@roomote/types';

import { useUser } from '@/hooks/useUser';
import { generateClientUuid } from '@/lib/client-uuid';
import { useTRPCClient } from '@/trpc/client';

import {
  BasicTooltip,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  Wrench,
} from '@/components/system';
import {
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuTrigger,
} from '@/components/ai-elements';

import {
  useSandboxClient,
  useSandboxConnected,
  useSandboxCurrentUserInfo,
} from '../hooks/SandboxProvider';

import { TASK_TOOL_CATALOG } from '../task-tools';

import { type SidebarActionBaseProps } from './types';
import { isTaskRunAsleep } from './utils';

export function TaskToolsMenu({
  onSelect,
  disabled = false,
}: {
  onSelect: (actionId: TaskToolActionId) => void | Promise<void>;
  disabled?: boolean;
}) {
  return (
    <PromptInputActionMenu>
      <BasicTooltip content="Task Tools">
        <PromptInputActionMenuTrigger
          aria-label="Task Tools"
          className="hover:bg-secondary"
          disabled={disabled}
        >
          <Wrench className="size-4" />
        </PromptInputActionMenuTrigger>
      </BasicTooltip>
      <PromptInputActionMenuContent>
        <DropdownMenuLabel>Task Tools</DropdownMenuLabel>
        {TASK_TOOL_CATALOG.map(({ actionId, label, separator, icon: Icon }) => (
          <Fragment key={actionId}>
            {separator && <DropdownMenuSeparator />}
            <DropdownMenuItem
              disabled={disabled}
              onClick={() => void onSelect(actionId)}
              className="flex items-center gap-2 cursor-pointer min-w-64"
            >
              <Icon className="size-4" />
              <span>{label}</span>
            </DropdownMenuItem>
          </Fragment>
        ))}
      </PromptInputActionMenuContent>
    </PromptInputActionMenu>
  );
}

function TaskToolsButtonBase({
  taskRun,
}: Pick<SidebarActionBaseProps, 'taskRun'>) {
  const client = useSandboxClient();
  const trpcClient = useTRPCClient();
  const connected = useSandboxConnected();
  const currentUserInfo = useSandboxCurrentUserInfo();
  const { user } = useUser();
  const userImageUrl =
    currentUserInfo?.userImageUrl ?? user?.resource.imageUrl ?? undefined;

  if (!taskRun || !client || !connected) {
    return null;
  }

  const asleep = isTaskRunAsleep(taskRun);

  if (asleep) {
    return null;
  }

  return (
    <TaskToolsMenu
      onSelect={async (actionId) => {
        const clientMessageId = generateClientUuid();

        try {
          await trpcClient.sandboxSession.sendPrompt.mutate({
            taskId: taskRun.taskId,
            taskTool: { actionId },
            source: 'web',
            clientMessageId,
            userImageUrl,
          });
        } catch (error) {
          toast.error(
            error instanceof Error
              ? error.message
              : 'Failed to send task tool.',
          );
        }
      }}
    />
  );
}

export const TaskToolsButton = memo(TaskToolsButtonBase);
