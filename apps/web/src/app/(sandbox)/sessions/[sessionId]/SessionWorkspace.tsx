'use client';

import Link from 'next/link';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { getReasoningEffortLabel, type ReasoningEffort } from '@roomote/types';
import { useMediaQuery } from 'usehooks-ts';

import {
  formatInferenceCost,
  formatRepositoryName,
  getUserDisplayName,
  humanizeFilename,
} from '@/lib';
import { SessionStatusBadge } from '@/components/sessions/SessionStatusBadge';
import {
  getSessionSurfaceBrandIcon,
  getSessionSurfaceLabel,
} from '@/components/sessions/session-surfaces';
import { useLaunchTaskModels } from '@/hooks/task-models/useLaunchTaskModels';
import { useTRPC } from '@/trpc/client';
import { FramedSurface, WorkspaceSurface } from '@/components/layout';
import { SideNavItem } from '@/components/layout/side-nav/SideNavItem';
import {
  ArrowLeftFromLine,
  Avatar,
  BasicTooltip,
  BrandIcon,
  Brain,
  Button,
  Calendar,
  DollarSign,
  FileText,
  Globe,
  Image,
  Info,
  Slack,
  X,
  Rows4,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/system';
import { SandboxSidePanelHeader } from '../../SandboxSidePanelHeader';
import {
  SandboxInfoPanel,
  SandboxInfoRow,
  SandboxInfoTable,
} from '../../SandboxInfoPanel';
import {
  ResponsiveWorkspacePanels,
  SandboxSideActions,
} from '../../SandboxWorkspacePanels';
import {
  useResponsiveSandboxSidebar,
  useSandboxLayout,
} from '../../use-sandbox-layout';
import { NestedTaskSidePanel } from './NestedTaskSidePanel';
import { OpenSessionTaskPanelContext } from './session-task-panel-context';
import { DelegatedTaskCard } from '../../task/[taskId]/messages/acp/DelegatedTaskCard';

type SessionTaskSummary = {
  taskId: string;
  title: string;
  workflow: string;
  state: string;
  repositoryName: string | null;
  latestOutput: string | null;
  inferenceCostMicroUsd: number;
  canAccessDetails?: boolean;
  latestRun: {
    id: number;
    status: string;
    taskPhase: string | null;
    error: string | null;
    result: unknown;
  } | null;
  artifacts: Array<{
    id: string;
    path: string;
    artifactType: string;
    contentType: string;
    thumbnailUrl?: string;
  }>;
  pullRequests: Array<{
    id: string;
    url: string;
    number: number | null;
    title: string | null;
    repository: string | null;
    status: string | null;
  }>;
};

export type SessionInfo = {
  id: string;
  ownerName: string | null;
  ownerEmail: string | null;
  ownerImageUrl: string | null;
  surface: string;
  /** Effective model for the session's turns (stored override or default). */
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  inferenceCostMicroUsd: number;
  createdAt: Date;
  status: string | null;
  tasks: SessionTaskSummary[];
  taskSource?: 'unified' | 'fast';
  taskCards?: Array<Pick<SessionTaskSummary, 'taskId' | 'title'>>;
};

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
            <p className="text-muted-foreground">
              {formatRepositoryName(task.repositoryName)}
            </p>
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
                title={artifact.path}
                className="group flex min-w-0 items-center gap-3 rounded-lg border bg-card p-2 transition-opacity hover:opacity-70"
              >
                {artifact.contentType.startsWith('image/') ? (
                  <span className="flex aspect-video w-20 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted">
                    {artifact.thumbnailUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={artifact.thumbnailUrl}
                        alt={humanizeFilename(artifact.path)}
                        className="size-full object-contain"
                        loading="lazy"
                      />
                    ) : (
                      <Image className="size-5 text-muted-foreground" />
                    )}
                  </span>
                ) : (
                  <span className="flex aspect-video w-20 shrink-0 items-center justify-center rounded-md bg-muted">
                    <FileText className="size-5 text-muted-foreground" />
                  </span>
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-primary group-hover:underline">
                    {humanizeFilename(artifact.path)}
                  </span>
                  <span className="block truncate font-mono text-xs text-muted-foreground">
                    {artifact.path}
                  </span>
                </span>
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

function SessionTasksPanel({
  tasks,
  onOpenTask,
  onClose,
}: {
  tasks: Array<Pick<SessionTaskSummary, 'taskId' | 'title'>>;
  onOpenTask: (taskId: string) => void;
  onClose: () => void;
}) {
  return (
    <FramedSurface
      frameClassName="p-0"
      surfaceClassName="relative flex flex-col overflow-hidden"
    >
      <SandboxSidePanelHeader
        title="Tasks"
        closeLabel="Close tasks"
        onClose={onClose}
      />
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-4 py-2">
        {tasks.map((task) => (
          <DelegatedTaskCard
            key={task.taskId}
            taskId={task.taskId}
            prompt={task.title}
            onOpen={onOpenTask}
          />
        ))}
      </div>
    </FramedSurface>
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
  const modelAndReasoningLabel = [
    modelLabel ?? 'Default model',
    session.reasoningEffort
      ? getReasoningEffortLabel(session.reasoningEffort)
      : null,
  ]
    .filter(Boolean)
    .join(' • ');
  const inferenceCostLabel = formatInferenceCost(session.inferenceCostMicroUsd);
  const surfaceLabel = getSessionSurfaceLabel(session.surface);
  const surfaceBrandIcon = getSessionSurfaceBrandIcon(session.surface);

  return (
    <FramedSurface
      frameClassName="p-0"
      surfaceClassName="relative flex flex-col overflow-hidden"
    >
      <SandboxInfoPanel
        title="Session Info"
        closeLabel="Close session info"
        onClose={onClose}
      >
        <SandboxInfoTable>
          <SandboxInfoRow label="Creator">
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
          </SandboxInfoRow>
          <SandboxInfoRow label="Model">
            <span className="inline-flex items-center gap-1.5">
              <Brain className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{modelAndReasoningLabel}</span>
            </span>
          </SandboxInfoRow>
          <SandboxInfoRow label="Inference Cost">
            <span className="inline-flex items-center gap-1.5">
              <DollarSign className="size-3.5 shrink-0 text-muted-foreground" />
              {inferenceCostLabel}
            </span>
          </SandboxInfoRow>
          <SandboxInfoRow label="Started At">
            <span className="inline-flex items-center gap-1.5">
              <Calendar className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">
                {session.createdAt.toLocaleString(undefined, {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                })}
              </span>
            </span>
          </SandboxInfoRow>
          <SandboxInfoRow label="Started From">
            <span className="inline-flex items-center gap-1.5">
              {session.surface === 'slack' ? (
                <Slack className="size-3.5 shrink-0 text-muted-foreground" />
              ) : surfaceBrandIcon ? (
                <BrandIcon
                  icon={surfaceBrandIcon}
                  name={surfaceLabel}
                  className="size-3.5 shrink-0 text-muted-foreground"
                />
              ) : (
                <Globe className="size-3.5 shrink-0 text-muted-foreground" />
              )}
              <span className="truncate">{surfaceLabel}</span>
            </span>
          </SandboxInfoRow>
          {session.status ? (
            <SandboxInfoRow label="Status">
              <SessionStatusBadge status={session.status} />
            </SandboxInfoRow>
          ) : null}
        </SandboxInfoTable>
      </SandboxInfoPanel>
    </FramedSurface>
  );
}

type WorkspacePanel =
  | { kind: 'info' }
  | { kind: 'tasks' }
  | { kind: 'nested'; taskId: string };

export function SessionWorkspace({
  session,
  children,
}: {
  session: SessionInfo;
  children: ReactNode;
}) {
  // Exactly one side panel can be active: the discriminated union makes an
  // impossible combination unrepresentable. The URL's ?task= selection is the
  // fourth panel and always wins over `panel` when both are set.
  const [panel, setPanel] = useState<WorkspacePanel | null>(null);
  const trpc = useTRPC();
  const router = useRouter();
  const searchParams = useSearchParams();
  const isMdOrLarger = useMediaQuery('(min-width: 768px)');
  const isFastTaskSource = session.taskSource === 'fast';
  const { data: currentSession } = useQuery(
    trpc.sessions.byId.queryOptions(
      { sessionId: session.id },
      {
        enabled: !isFastTaskSource,
        // Settled sessions poll slowly; only visibly-running work needs the
        // fast cadence. TanStack pauses both while the tab is unfocused.
        refetchInterval: (query) =>
          query.state.data?.status === 'active' ||
          query.state.data?.status === 'needs_input'
            ? 2_000
            : 30_000,
      },
    ),
  );
  const { data: currentFastTasks } = useQuery(
    trpc.fastSessions.tasks.queryOptions(
      { sessionId: session.id },
      {
        enabled: isFastTaskSource,
        refetchInterval: 2_000,
      },
    ),
  );
  const sessionTasks = currentSession?.tasks ?? session.tasks;
  const taskCards = isFastTaskSource
    ? (currentFastTasks ?? session.taskCards ?? session.tasks)
    : sessionTasks;
  const selectedTaskId = searchParams.get('task');
  const selectedTask = sessionTasks.find(
    (task) => task.taskId === selectedTaskId,
  );
  const panelOpen = panel !== null || Boolean(selectedTask);

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

  // Desktop keeps the single-task split-panel default. Mobile starts on the
  // transcript unless a task was selected explicitly through the URL.
  const didAutoSelect = useRef(false);
  useEffect(() => {
    if (
      !isMdOrLarger ||
      didAutoSelect.current ||
      selectedTask ||
      sessionTasks.length !== 1
    ) {
      return;
    }
    didAutoSelect.current = true;
    selectTask(sessionTasks[0]!.taskId);
  }, [isMdOrLarger, selectTask, selectedTask, sessionTasks]);

  const openTaskPanel = useCallback(
    (taskId: string) => {
      setPanel({ kind: 'nested', taskId });
      selectTask(null);
    },
    [selectTask],
  );
  const closePanel = () => {
    setPanel(null);
    selectTask(null);
  };
  const togglePanel = (kind: 'info' | 'tasks') => {
    setPanel((previous) => (previous?.kind === kind ? null : { kind }));
    selectTask(null);
  };
  const panelContent = selectedTask ? (
    <SessionTaskPanel
      sessionId={session.id}
      task={selectedTask}
      tasks={sessionTasks}
      onSelect={selectTask}
      onClose={closePanel}
    />
  ) : panel?.kind === 'nested' ? (
    <NestedTaskSidePanel taskId={panel.taskId} onClose={closePanel} />
  ) : panel?.kind === 'tasks' ? (
    <SessionTasksPanel
      tasks={taskCards}
      onOpenTask={openTaskPanel}
      onClose={closePanel}
    />
  ) : (
    <SessionInfoPanel session={session} onClose={closePanel} />
  );
  const { isSidebarVisible, toggleSidebar } = useSandboxLayout();
  useResponsiveSandboxSidebar(session.id);

  return (
    <OpenSessionTaskPanelContext.Provider value={openTaskPanel}>
      <WorkspaceSurface
        className="relative"
        sideActions={
          <>
            <SandboxSideActions isPanelOpen={panelOpen} onShowMain={closePanel}>
              <SideNavItem
                side="right"
                label="Session info"
                tooltip="Session info"
                active={panel?.kind === 'info' && !selectedTask}
                icon={Info}
                onClick={() => togglePanel('info')}
              />
              <SideNavItem
                side="right"
                label="Tasks"
                tooltip="Tasks"
                active={panel?.kind === 'tasks' && !selectedTask}
                disabled={taskCards.length === 0}
                icon={Rows4}
                onClick={() => togglePanel('tasks')}
              />
            </SandboxSideActions>
            {!isSidebarVisible && !panelOpen ? (
              <BasicTooltip content="Show sidebar">
                <Button
                  variant="ghost"
                  className="absolute top-2.5 right-3 size-8 shrink-0 md:hidden"
                  aria-label="Show sidebar"
                  onClick={toggleSidebar}
                >
                  <ArrowLeftFromLine className="size-4" />
                </Button>
              </BasicTooltip>
            ) : null}
          </>
        }
      >
        <ResponsiveWorkspacePanels
          isPanelOpen={panelOpen}
          main={children}
          panel={panelContent}
        />
      </WorkspaceSurface>
    </OpenSessionTaskPanelContext.Provider>
  );
}
