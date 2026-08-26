'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { formatDistanceToNow } from 'date-fns';

import { formatInferenceCost, getUserDisplayName } from '@/lib';
import { useLaunchTaskModels } from '@/hooks/task-models/useLaunchTaskModels';
import { useIsMobile } from '@/hooks/useIsMobile';
import { WorkspaceSurface } from '@/components/layout';
import { SideNavItem } from '@/components/layout/side-nav/SideNavItem';
import {
  Avatar,
  BasicTooltip,
  Button,
  DollarSign,
  Info,
  ResizableDivider,
  ResizablePanel,
  ResizablePanelGroup,
  X,
  Rows4,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from '@/components/system';
import type { SessionTaskSummary } from './SessionTaskCards';

export type SessionInfo = {
  id: string;
  ownerName: string | null;
  ownerEmail: string | null;
  ownerImageUrl: string | null;
  surface: string;
  /** Effective model for the session's turns (stored override or default). */
  model: string | null;
  inferenceCostMicroUsd: number;
  createdAt: Date;
  tasks: SessionTaskSummary[];
};

const SURFACE_LABELS: Record<string, string> = {
  slack: 'Slack',
  discord: 'Discord',
  automation: 'Automation',
  web: 'Web',
};

function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <tr>
      <td className="py-1 pr-4 align-top whitespace-nowrap">{label}</td>
      <td className="ph-no-capture min-w-0 py-1 break-all">{children}</td>
    </tr>
  );
}

function SessionTaskPanel({
  sessionId,
  task,
  tasks,
  onSelect,
  onClose,
}: {
  sessionId: string;
  task: SessionTaskSummary;
  tasks: SessionTaskSummary[];
  onSelect: (taskId: string) => void;
  onClose: () => void;
}) {
  return (
    <>
      <div className="flex shrink-0 items-center justify-between gap-2 border-b-2 border-card px-4 py-2">
        <h2 className="truncate text-sm font-medium">Execution details</h2>
        <BasicTooltip content="Close">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Close execution details"
            onClick={onClose}
          >
            <X />
          </Button>
        </BasicTooltip>
      </div>
      <div className="scroll-thin min-h-0 flex-1 space-y-4 overflow-y-auto p-4 text-sm">
        {tasks.length > 1 ? (
          <Select value={task.taskId} onValueChange={onSelect}>
            <SelectTrigger aria-label="Choose execution">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {tasks.map((item) => (
                <SelectItem key={item.taskId} value={item.taskId}>
                  {item.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
        <div className="space-y-1">
          <h3 className="font-medium">{task.title}</h3>
          <p className="text-muted-foreground capitalize">{task.state}</p>
          {task.repositoryName ? (
            <p className="text-muted-foreground">{task.repositoryName}</p>
          ) : null}
        </div>
        {task.canAccessDetails === false ? (
          <p className="rounded-md border bg-muted p-3 text-muted-foreground">
            Execution details require task access.
          </p>
        ) : null}
        {task.latestRun?.error ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-destructive">
            {task.latestRun.error}
          </div>
        ) : null}
        {task.pullRequests.length ? (
          <section className="space-y-2">
            <h3 className="font-medium">Pull requests</h3>
            {task.pullRequests.map((pullRequest) => (
              <a
                key={pullRequest.id}
                href={pullRequest.url}
                target="_blank"
                rel="noreferrer"
                className="block truncate text-primary hover:underline"
              >
                {pullRequest.repository}#{pullRequest.number}
              </a>
            ))}
          </section>
        ) : null}
        {task.artifacts.length ? (
          <section className="space-y-2">
            <h3 className="font-medium">Artifacts</h3>
            {task.artifacts.map((artifact) => (
              <Link
                key={artifact.id}
                href={`/task/${task.taskId}/artifacts/${encodeURIComponent(artifact.path)}?returnTo=${encodeURIComponent(`/sessions/${sessionId}?task=${task.taskId}`)}`}
                className="block truncate text-primary hover:underline"
              >
                {artifact.path}
              </Link>
            ))}
          </section>
        ) : null}
        {task.canAccessDetails === false ? null : (
          <Button asChild className="w-full">
            <Link
              href={`/task/${task.taskId}?returnTo=${encodeURIComponent(`/sessions/${sessionId}?task=${task.taskId}`)}`}
            >
              Open full workspace
            </Link>
          </Button>
        )}
      </div>
    </>
  );
}

function SessionInfoPanel({
  session,
  onClose,
}: {
  session: SessionInfo;
  onClose: () => void;
}) {
  const ownerDisplayName =
    getUserDisplayName({
      name: session.ownerName,
      email: session.ownerEmail,
    }) ?? 'Unknown';
  const { data: modelData } = useLaunchTaskModels();
  const modelLabel = session.model
    ? (modelData?.models.find(({ id }) => id === session.model)?.displayName ??
      session.model)
    : null;
  const inferenceCostLabel = formatInferenceCost(session.inferenceCostMicroUsd);

  return (
    <>
      <div className="flex shrink-0 items-center justify-between gap-2 border-b-2 border-card px-4 py-2">
        <h2 className="text-sm font-medium">Session info</h2>
        <BasicTooltip content="Close">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Close session info"
            onClick={onClose}
          >
            <X />
          </Button>
        </BasicTooltip>
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <table className="text-sm">
          <tbody>
            <InfoRow label="Creator">
              <span className="inline-flex items-center gap-2">
                <Avatar
                  imageUrl={session.ownerImageUrl}
                  name={ownerDisplayName}
                  email={session.ownerEmail ?? undefined}
                  size="sm"
                  alt={ownerDisplayName}
                />
                {ownerDisplayName}
              </span>
            </InfoRow>
            <InfoRow label="Model">{modelLabel ?? 'Default model'}</InfoRow>
            <InfoRow label="Inference cost">
              <span className="inline-flex items-center gap-1">
                <DollarSign className="size-3 shrink-0" />
                {inferenceCostLabel}
              </span>
            </InfoRow>
            <InfoRow label="Started at">
              <BasicTooltip content={session.createdAt.toLocaleString()}>
                <span className="cursor-default">
                  {formatDistanceToNow(session.createdAt, { addSuffix: true })}
                </span>
              </BasicTooltip>
            </InfoRow>
            <InfoRow label="Started from">
              {SURFACE_LABELS[session.surface] ?? session.surface}
            </InfoRow>
          </tbody>
        </table>
      </div>
    </>
  );
}

export function SessionWorkspace({
  session,
  children,
}: {
  session: SessionInfo;
  children: ReactNode;
}) {
  const [isInfoOpen, setIsInfoOpen] = useState(false);
  const isMobile = useIsMobile();
  const router = useRouter();
  const searchParams = useSearchParams();
  const selectedTaskId = searchParams.get('task');
  const selectedTask = session.tasks.find(
    (task) => task.taskId === selectedTaskId,
  );
  const panelOpen = isInfoOpen || Boolean(selectedTask);

  const selectTask = useCallback(
    (taskId: string | null) => {
      const params = new URLSearchParams(searchParams);
      if (taskId) params.set('task', taskId);
      else params.delete('task');
      const query = params.toString();
      router.replace(`/sessions/${session.id}${query ? `?${query}` : ''}`);
    },
    [router, searchParams, session.id],
  );

  useEffect(() => {
    if (!selectedTaskId && session.tasks.length === 1) {
      selectTask(session.tasks[0]!.taskId);
    }
  }, [selectTask, selectedTaskId, session.tasks]);

  const closePanel = () => {
    setIsInfoOpen(false);
    selectTask(null);
  };
  const panelContent = selectedTask ? (
    <SessionTaskPanel
      sessionId={session.id}
      task={selectedTask}
      tasks={session.tasks}
      onSelect={selectTask}
      onClose={closePanel}
    />
  ) : (
    <SessionInfoPanel session={session} onClose={closePanel} />
  );

  return (
    <WorkspaceSurface
      sideActions={
        <div className="flex h-full shrink-0 flex-col gap-2 overflow-y-auto bg-card py-3 pr-2">
          <SideNavItem
            side="right"
            label="Session info"
            tooltip="Session info"
            active={isInfoOpen}
            icon={Info}
            onClick={() => setIsInfoOpen((previous) => !previous)}
          />
          {session.tasks.length ? (
            <SideNavItem
              side="right"
              label="Executions"
              tooltip="Executions"
              active={Boolean(selectedTask)}
              icon={Rows4}
              onClick={() =>
                selectTask(selectedTask ? null : session.tasks[0]!.taskId)
              }
            />
          ) : null}
        </div>
      }
    >
      {isMobile ? (
        <>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
          <Drawer
            direction="right"
            open={panelOpen}
            onOpenChange={(open) => {
              if (!open) closePanel();
            }}
          >
            <DrawerContent className="flex h-full w-[min(90vw,26rem)] flex-col">
              <DrawerHeader className="sr-only">
                <DrawerTitle>Session execution details</DrawerTitle>
              </DrawerHeader>
              {panelContent}
            </DrawerContent>
          </Drawer>
        </>
      ) : (
        <ResizablePanelGroup direction="horizontal" className="min-h-0 flex-1">
          <ResizablePanel
            defaultSize={panelOpen ? 65 : 100}
            minSize={30}
            className="flex min-h-0 min-w-0 flex-col"
          >
            {children}
          </ResizablePanel>
          {panelOpen ? (
            <>
              <ResizableDivider />
              <ResizablePanel
                defaultSize={35}
                minSize={20}
                className="flex min-h-0 min-w-0 flex-col border-l-2 border-card"
              >
                {panelContent}
              </ResizablePanel>
            </>
          ) : null}
        </ResizablePanelGroup>
      )}
    </WorkspaceSurface>
  );
}
