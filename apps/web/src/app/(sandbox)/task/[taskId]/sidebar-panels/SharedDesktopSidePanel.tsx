'use client';

import { SHARED_DESKTOP_NAMED_PORT } from '@roomote/types';
import type { TaskRun } from '@roomote/db';

import { usePreviewUrls } from '../hooks/use-preview-urls';

import { DesktopStreamClient } from './DesktopStreamClient';
import { SidePanelHeader } from './SidePanelHeader';

export function SharedDesktopSidePanel({
  taskRun,
  onClose,
}: {
  taskRun: TaskRun;
  onClose: () => void;
}) {
  const { previewUrls } = usePreviewUrls(taskRun);
  const desktopUrl = previewUrls?.[SHARED_DESKTOP_NAMED_PORT.name];

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      {desktopUrl ? (
        <div className="relative min-h-0 flex-1 bg-card">
          <DesktopStreamClient
            previewUrl={desktopUrl}
            runId={taskRun.id}
            onClose={onClose}
            popoutHref={`/task/${taskRun.taskId}/shared-desktop/popout`}
          />
        </div>
      ) : (
        <>
          <SidePanelHeader title="Shared Desktop" onClose={onClose} />
          <div className="grid size-full place-items-center p-6 text-center text-sm text-muted-foreground">
            Shared Desktop is unavailable for this task.
          </div>
        </>
      )}
    </div>
  );
}
