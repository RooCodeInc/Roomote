'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { Button, ShieldQuestion } from '@/components/system';
import type { IntegrationToolApprovalMetadata } from '@roomote/types';

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
 * The experiment-gated (`integrationToolApprovals`) card asking the Session
 * requester to allow one gated integration tool call or reject it. Allowing
 * resumes that exact paused call once through OpenCode's native permission
 * reply; it never creates a standing rule. The card disappears once the call
 * is decided or the approval expires unanswered.
 */
export function PendingIntegrationToolApprovals({
  sessionId,
  pending,
}: {
  sessionId: string;
  pending: IntegrationToolApprovalMetadata[];
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
        `/api/sessions/${encodeURIComponent(sessionId)}/integration-tool-approvals`,
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
        queryKey: ['session-integration-tool-approvals', sessionId],
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
              {item.shadowEvaluation ? (
                <p className="text-xs text-muted-foreground">
                  Auto preview: the judgment model{' '}
                  {item.shadowEvaluation.recommendation === 'would_approve'
                    ? 'would have approved this call'
                    : 'would have asked you'}
                  {typeof item.shadowEvaluation.confidence === 'number'
                    ? ` (confidence ${Math.round(
                        item.shadowEvaluation.confidence * 100,
                      )}%)`
                    : ''}
                  . Your decision is still required.
                </p>
              ) : null}
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
