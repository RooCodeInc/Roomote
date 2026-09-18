'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { Button, ShieldQuestion } from '@/components/system';
import type { ToolCallApprovalMetadata } from '@roomote/types';

function summarizeArgs(argsSummary: unknown): string {
  if (
    argsSummary === null ||
    argsSummary === undefined ||
    (typeof argsSummary === 'object' &&
      !Array.isArray(argsSummary) &&
      Object.keys(argsSummary as Record<string, unknown>).length === 0)
  ) {
    return 'No arguments';
  }
  const rendered = JSON.stringify(argsSummary);
  return rendered.length > 160 ? `${rendered.slice(0, 160)}…` : rendered;
}

/**
 * The experiment-gated (`toolApprovals`) card asking the Session requester to
 * allow one on-demand integration tool call or reject it. Allowing runs that
 * exact call once; it never creates a standing rule. The card disappears
 * once the call is decided or the approval expires unanswered.
 */
export function PendingToolApprovals({
  sessionId,
  pending,
}: {
  sessionId: string;
  pending: ToolCallApprovalMetadata[];
}) {
  const queryClient = useQueryClient();
  const [busyId, setBusyId] = useState<string | null>(null);
  if (pending.length === 0) return null;

  const decide = async (
    approvalId: string,
    decision: 'approved' | 'rejected',
  ) => {
    setBusyId(approvalId);
    try {
      await fetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/tool-approvals`,
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ approvalId, decision }),
        },
      );
    } finally {
      setBusyId(null);
      await queryClient.invalidateQueries({
        queryKey: ['session-tool-approvals', sessionId],
      });
    }
  };

  return (
    <div className="mt-4 space-y-2" data-testid="pending-tool-approvals">
      {pending.map((item) => (
        <section
          key={item.approvalId}
          aria-label={`Approve ${item.toolName}`}
          className="rounded-xl bg-card p-4 text-sm"
        >
          <div className="flex flex-wrap items-center gap-3">
            <ShieldQuestion
              aria-hidden="true"
              className="size-5 shrink-0 text-muted-foreground"
            />
            <div className="min-w-0 flex-1">
              <p className="font-medium">
                Allow {item.integrationId} to run {item.toolName}?
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {summarizeArgs(item.argsSummary)}
              </p>
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                type="button"
                disabled={busyId === item.approvalId}
                onClick={() => void decide(item.approvalId, 'approved')}
              >
                Allow once
              </Button>
              <Button
                size="sm"
                type="button"
                variant="outline"
                disabled={busyId === item.approvalId}
                onClick={() => void decide(item.approvalId, 'rejected')}
              >
                Reject
              </Button>
            </div>
          </div>
        </section>
      ))}
    </div>
  );
}
