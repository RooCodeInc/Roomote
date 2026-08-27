'use client';

import { useLayoutEffect, useState, type ReactNode } from 'react';
import { formatDistanceToNow } from 'date-fns';

import { formatInferenceCost, getUserDisplayName } from '@/lib';
import { useLaunchTaskModels } from '@/hooks/task-models/useLaunchTaskModels';
import { WorkspaceSurface } from '@/components/layout';
import { SideNavItem } from '@/components/layout/side-nav/SideNavItem';
import {
  ArrowLeftFromLine,
  Avatar,
  BasicTooltip,
  Button,
  DollarSign,
  Info,
} from '@/components/system';

import { SandboxSidePanelHeader } from '../../SandboxSidePanelHeader';
import {
  ResponsiveWorkspacePanels,
  SandboxSideActions,
} from '../../SandboxWorkspacePanels';
import { useSandboxLayout } from '../../use-sandbox-layout';

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
  teams: 'Microsoft Teams',
  telegram: 'Telegram',
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
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <SandboxSidePanelHeader
        title="Session info"
        closeLabel="Close session info"
        onClose={onClose}
      />
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
    </div>
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
  const { isSidebarVisible, setSidebarVisible, toggleSidebar } =
    useSandboxLayout();

  useLayoutEffect(() => {
    const mobileQuery = window.matchMedia?.('(max-width: 767px)');

    if (!mobileQuery?.matches) {
      return;
    }

    setSidebarVisible(false);

    const handleViewportChange = (event: MediaQueryListEvent) =>
      setSidebarVisible(!event.matches);

    mobileQuery.addEventListener('change', handleViewportChange);

    return () => {
      mobileQuery.removeEventListener('change', handleViewportChange);
      setSidebarVisible(true);
    };
  }, [session.id, setSidebarVisible]);

  return (
    <WorkspaceSurface
      className="relative"
      sideActions={
        <>
          <SandboxSideActions
            isPanelOpen={isInfoOpen}
            onShowMain={() => setIsInfoOpen(false)}
          >
            <SideNavItem
              side="right"
              label="Session info"
              tooltip="Session info"
              active={isInfoOpen}
              icon={Info}
              onClick={() => setIsInfoOpen((previous) => !previous)}
            />
          </SandboxSideActions>
          {!isSidebarVisible && !isInfoOpen ? (
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
        isPanelOpen={isInfoOpen}
        main={children}
        mainSize={65}
        panelSize={35}
        panel={
          <SessionInfoPanel
            session={session}
            onClose={() => setIsInfoOpen(false)}
          />
        }
      />
    </WorkspaceSurface>
  );
}
