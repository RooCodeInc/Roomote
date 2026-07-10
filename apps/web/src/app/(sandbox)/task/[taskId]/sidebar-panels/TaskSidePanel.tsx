'use client';

import { FramedSurface } from '@/components/layout';
import { cn } from '@/lib/utils';

import type { TaskSession, GitDiffResponse } from '../hooks';

import { useTaskSidePanel } from '../hooks';

import { PreviewSidePanel } from './PreviewSidePanel';
import { DiffSidePanel } from './DiffSidePanel';
import { ArtifactsSidePanel } from './ArtifactsSidePanel';
import { LogsSidePanel } from './LogsSidePanel';
import { TaskInfoPanel } from './TaskInfoPanel';
import { TerminalSidePanel } from './TerminalSidePanel';

interface DiffPanelProps {
  data: GitDiffResponse | undefined;
  error: Error | null;
  isLoading: boolean;
  onRefresh: () => void;
}

interface TaskSidePanelDesktopProps {
  session: TaskSession;
  diffPanel?: DiffPanelProps;
}

export function TaskSidePanelDesktop({
  session,
  diffPanel,
}: TaskSidePanelDesktopProps) {
  const { activeView, closeSidePanel } = useTaskSidePanel();

  return (
    <FramedSurface
      frameClassName="p-0"
      surfaceClassName="relative flex flex-col overflow-hidden "
    >
      <div
        className={cn(
          'absolute inset-0 min-h-0 min-w-0',
          activeView === 'artifacts' ? 'flex' : 'hidden',
        )}
      >
        <ArtifactsSidePanel session={session} />
      </div>

      <div
        className={cn(
          'absolute inset-0 min-h-0 min-w-0 flex-col',
          activeView === 'preview' ? 'flex' : 'hidden',
        )}
      >
        {activeView === 'preview' ? (
          <PreviewSidePanel
            taskRun={session.taskRun ?? undefined}
            onClose={closeSidePanel}
          />
        ) : null}
      </div>

      <div
        className={cn(
          'absolute inset-0 min-h-0 min-w-0',
          activeView === 'diff' ? 'flex' : 'hidden',
        )}
      >
        {diffPanel ? (
          <DiffSidePanel
            data={diffPanel.data}
            error={diffPanel.error}
            isLoading={diffPanel.isLoading}
            onRefresh={diffPanel.onRefresh}
            onClose={closeSidePanel}
          />
        ) : null}
      </div>

      <div
        className={cn(
          'absolute inset-0 min-h-0 min-w-0 flex-col',
          activeView === 'task-info' ? 'flex' : 'hidden',
        )}
      >
        {session.task && session.taskRun ? (
          <TaskInfoPanel
            active={activeView === 'task-info'}
            task={session.task}
            taskRun={session.taskRun}
            harness={session.harness}
            onClose={closeSidePanel}
          />
        ) : null}
      </div>

      <div
        className={cn(
          'absolute inset-0 min-h-0 min-w-0 flex-col',
          activeView === 'terminal' ? 'flex' : 'hidden',
        )}
      >
        {session.taskRun && session.sessionState === 'interactive' ? (
          <TerminalSidePanel
            active={activeView === 'terminal'}
            onClose={closeSidePanel}
          />
        ) : null}
      </div>

      <div
        className={cn(
          'absolute inset-0 min-h-0 min-w-0 flex-col',
          activeView === 'logs' ? 'flex' : 'hidden',
        )}
      >
        {session.taskRun && session.sessionState === 'interactive' ? (
          <LogsSidePanel
            active={activeView === 'logs'}
            onClose={closeSidePanel}
          />
        ) : null}
      </div>
    </FramedSurface>
  );
}
