'use client';

import { useState, type ReactNode } from 'react';
import { formatDistanceToNow } from 'date-fns';

import { getUserDisplayName } from '@/lib';
import { WorkspaceSurface } from '@/components/layout';
import { SideNavItem } from '@/components/layout/side-nav/SideNavItem';
import {
  Avatar,
  BasicTooltip,
  Button,
  Info,
  ResizableDivider,
  ResizablePanel,
  ResizablePanelGroup,
  X,
} from '@/components/system';

export type SessionInfo = {
  id: string;
  ownerName: string | null;
  ownerEmail: string | null;
  ownerImageUrl: string | null;
  surface: string;
  workspaceId: string;
  conversationId: string;
  openCodeSessionId: string | null;
  messageCount: number;
  createdAt: Date;
  updatedAt: Date;
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
            <InfoRow label="Owner">
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
            <InfoRow label="Surface">
              <span className="capitalize">{session.surface}</span>
            </InfoRow>
            <InfoRow label="Messages">{session.messageCount}</InfoRow>
            <InfoRow label="Context">
              {session.openCodeSessionId ? 'Native context' : 'Stored history'}
            </InfoRow>
            <InfoRow label="Created">
              <BasicTooltip content={session.createdAt.toLocaleString()}>
                <span className="cursor-default">
                  {formatDistanceToNow(session.createdAt, { addSuffix: true })}
                </span>
              </BasicTooltip>
            </InfoRow>
            <InfoRow label="Last activity">
              <BasicTooltip content={session.updatedAt.toLocaleString()}>
                <span className="cursor-default">
                  {formatDistanceToNow(session.updatedAt, { addSuffix: true })}
                </span>
              </BasicTooltip>
            </InfoRow>
            <InfoRow label="Conversation">{session.conversationId}</InfoRow>
            <InfoRow label="Workspace">{session.workspaceId}</InfoRow>
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
        </div>
      }
    >
      <ResizablePanelGroup direction="horizontal" className="min-h-0 flex-1">
        <ResizablePanel
          defaultSize={isInfoOpen ? 65 : 100}
          minSize={30}
          className="flex min-h-0 min-w-0 flex-col"
        >
          {children}
        </ResizablePanel>
        {isInfoOpen && (
          <>
            <ResizableDivider />
            <ResizablePanel
              defaultSize={35}
              minSize={20}
              className="flex min-h-0 min-w-0 flex-col border-l-2 border-card"
            >
              <SessionInfoPanel
                session={session}
                onClose={() => setIsInfoOpen(false)}
              />
            </ResizablePanel>
          </>
        )}
      </ResizablePanelGroup>
    </WorkspaceSurface>
  );
}
