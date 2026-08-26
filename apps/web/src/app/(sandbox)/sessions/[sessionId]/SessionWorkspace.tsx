'use client';

import { useCallback, useState, type ReactNode } from 'react';
import { formatDistanceToNow } from 'date-fns';

import { formatInferenceCost, getUserDisplayName } from '@/lib';
import { useLaunchTaskModels } from '@/hooks/task-models/useLaunchTaskModels';
import { WorkspaceSurface } from '@/components/layout';
import { SideNavItem } from '@/components/layout/side-nav/SideNavItem';
import {
  Avatar,
  BasicTooltip,
  DollarSign,
  Info,
  ResizableDivider,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/system';
import { SidePanelHeader } from '../../task/[taskId]/sidebar-panels/SidePanelHeader';
import { NestedTaskSidePanel } from './NestedTaskSidePanel';
import { OpenSessionTaskPanelContext } from './session-task-panel-context';

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
      <SidePanelHeader title="Session info" onClose={onClose} />
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

type SessionPanel = { type: 'info' } | { type: 'task'; taskId: string };

export function SessionWorkspace({
  session,
  children,
}: {
  session: SessionInfo;
  children: ReactNode;
}) {
  const [activePanel, setActivePanel] = useState<SessionPanel | null>(null);
  const openTaskPanel = useCallback((taskId: string) => {
    setActivePanel({ type: 'task', taskId });
  }, []);
  const isInfoOpen = activePanel?.type === 'info';
  const closePanel = useCallback(() => setActivePanel(null), []);

  return (
    <OpenSessionTaskPanelContext.Provider value={openTaskPanel}>
      <WorkspaceSurface
        sideActions={
          <div className="flex h-full shrink-0 flex-col gap-2 overflow-y-auto bg-card py-3 pr-2">
            <SideNavItem
              side="right"
              label="Session info"
              tooltip="Session info"
              active={isInfoOpen}
              icon={Info}
              onClick={() =>
                setActivePanel((previous) =>
                  previous?.type === 'info' ? null : { type: 'info' },
                )
              }
            />
          </div>
        }
      >
        <ResizablePanelGroup direction="horizontal" className="min-h-0 flex-1">
          <ResizablePanel
            defaultSize={activePanel ? 65 : 100}
            minSize={30}
            className="flex min-h-0 min-w-0 flex-col"
          >
            {children}
          </ResizablePanel>
          {activePanel ? (
            <>
              <ResizableDivider />
              <ResizablePanel
                defaultSize={35}
                minSize={20}
                className="flex min-h-0 min-w-0 flex-col border-l-2 border-card"
              >
                {activePanel.type === 'info' ? (
                  <SessionInfoPanel session={session} onClose={closePanel} />
                ) : (
                  <NestedTaskSidePanel
                    taskId={activePanel.taskId}
                    onClose={closePanel}
                  />
                )}
              </ResizablePanel>
            </>
          ) : null}
        </ResizablePanelGroup>
      </WorkspaceSurface>
    </OpenSessionTaskPanelContext.Provider>
  );
}
