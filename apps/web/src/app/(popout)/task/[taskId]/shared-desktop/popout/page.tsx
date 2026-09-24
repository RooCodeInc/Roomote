'use client';

import { useEffect } from 'react';
import { useParams } from 'next/navigation';

import { SHARED_DESKTOP_NAMED_PORT } from '@roomote/types';

import { usePreviewUrls } from '../../../../../(sandbox)/task/[taskId]/hooks/use-preview-urls';
import { useTaskSession } from '../../../../../(sandbox)/task/[taskId]/hooks/use-task-session';
import { DesktopStreamClient } from '../../../../../(sandbox)/task/[taskId]/sidebar-panels/DesktopStreamClient';

/**
 * Bare, full-window Shared Desktop for a task: what the panel's pop-out
 * button opens. No app chrome, no sidebar; just the desktop.
 */
export default function SharedDesktopPopoutPage() {
  const params = useParams<{ taskId: string }>();
  const taskId = params.taskId;
  const session = useTaskSession(taskId, { refetchInterval: 5_000 });
  const taskRun = session.taskRun;
  const { previewUrls } = usePreviewUrls(taskRun ?? {});
  const desktopUrl = previewUrls?.[SHARED_DESKTOP_NAMED_PORT.name];

  useEffect(() => {
    document.title = 'Shared Desktop | Roomote';
  }, []);

  return (
    <div className="h-dvh w-dvw bg-zinc-950">
      {taskRun && desktopUrl ? (
        <DesktopStreamClient
          previewUrl={desktopUrl}
          runId={taskRun.id}
          standalone
        />
      ) : (
        <div className="grid size-full place-items-center text-sm text-zinc-400">
          {session.isLoading
            ? 'Loading Shared Desktop'
            : 'Shared Desktop is unavailable for this task.'}
        </div>
      )}
    </div>
  );
}
