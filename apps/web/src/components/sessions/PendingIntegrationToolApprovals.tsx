'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import {
  Button,
  ChevronDown,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  ShieldQuestion,
} from '@/components/system';
import {
  MCP_INTEGRATIONS,
  type IntegrationToolApprovalMetadata,
} from '@roomote/types';

const integrationNames = new Map(
  MCP_INTEGRATIONS.map((integration) => [integration.id, integration.name]),
);

function formatIdentifier(value: string): string {
  return value
    .replace(/[.\-_]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (character) => character.toUpperCase())
    .trim();
}

function integrationDisplayName(integrationId: string): string {
  return integrationNames.get(integrationId) ?? formatIdentifier(integrationId);
}

function approvalPrompt(item: IntegrationToolApprovalMetadata): string {
  const name = integrationDisplayName(item.integrationId) || 'this integration';
  const normalizedToolName = item.toolName.toLowerCase();
  const argumentKeys =
    item.argsSummary &&
    typeof item.argsSummary === 'object' &&
    !Array.isArray(item.argsSummary)
      ? Object.keys(item.argsSummary as Record<string, unknown>).map((key) =>
          key.toLowerCase(),
        )
      : [];
  const referencesRepository = argumentKeys.some((key) =>
    [
      'repo',
      'repository',
      'reponame',
      'repositoryname',
      'repositoryfullname',
    ].includes(key),
  );
  const isReadAction =
    /^(ask|fetch|find|get|inspect|list|lookup|query|read|search)[._-]/.test(
      normalizedToolName,
    );

  if (referencesRepository && isReadAction) {
    return `Let ${name} inspect this repository?`;
  }

  return `Let ${name} use this tool?`;
}

function summarizeArgs(argsSummary: unknown): string | null {
  if (
    argsSummary === null ||
    argsSummary === undefined ||
    (typeof argsSummary === 'object' &&
      !Array.isArray(argsSummary) &&
      Object.keys(argsSummary as Record<string, unknown>).length === 0)
  ) {
    return null;
  }
  return JSON.stringify(argsSummary, null, 2) ?? null;
}

/**
 * The experiment-gated (`integrationToolApprovals`) card asking the Session
 * requester to allow one gated integration tool call or reject it. Allowing
 * resumes that exact paused call once through OpenCode's native permission
 * reply. "Allow for this session" also records a requester-owned
 * override so later calls to that tool in this Session run without a card;
 * it never changes the deployment policy or any other Session. The card
 * disappears once the call is decided or the approval expires unanswered.
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
    decision: 'approved' | 'approved_for_session' | 'rejected',
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
      {pending.map((item) => {
        const prompt = approvalPrompt(item);
        const args = summarizeArgs(item.argsSummary);
        return (
          <section
            key={item.approvalId}
            aria-label={prompt}
            className="rounded-xl bg-card p-4 text-sm"
          >
            <div className="flex items-start gap-3">
              <ShieldQuestion
                aria-hidden="true"
                className="mt-0.5 size-5 shrink-0 text-muted-foreground"
              />
              <div className="min-w-0 flex-1">
                <p className="font-medium">{prompt}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Roomote is waiting for your approval to continue.
                </p>
              </div>
            </div>

            <Collapsible className="mt-3">
              <CollapsibleTrigger className="group flex cursor-pointer items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
                Details
                <ChevronDown
                  aria-hidden="true"
                  className="size-3 transition-transform group-data-[state=open]:rotate-180"
                />
              </CollapsibleTrigger>
              <CollapsibleContent className="mt-2 rounded-lg bg-muted/50 p-3 text-xs">
                <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
                  <dt className="text-muted-foreground">Integration</dt>
                  <dd className="break-all font-mono">{item.integrationId}</dd>
                  <dt className="text-muted-foreground">Tool</dt>
                  <dd className="break-all font-mono">{item.toolName}</dd>
                </dl>
                <div className="mt-3">
                  <p className="text-muted-foreground">Arguments</p>
                  {args ? (
                    <pre className="mt-1 whitespace-pre-wrap break-words font-mono">
                      {args}
                    </pre>
                  ) : (
                    <p className="mt-1">No additional details.</p>
                  )}
                </div>
              </CollapsibleContent>
            </Collapsible>

            <div className="mt-4 flex flex-col gap-2 sm:flex-row">
              <Button
                className="w-full sm:w-auto"
                size="sm"
                type="button"
                disabled={busyId === item.approvalId}
                onClick={() => void decide(item.approvalId, 'approved')}
              >
                Allow once
              </Button>
              <Button
                className="w-full sm:w-auto"
                size="sm"
                type="button"
                variant="outline"
                disabled={busyId === item.approvalId}
                onClick={() =>
                  void decide(item.approvalId, 'approved_for_session')
                }
              >
                Allow for this session
              </Button>
              <Button
                className="self-center text-muted-foreground hover:text-destructive sm:ml-auto sm:self-auto"
                size="sm"
                type="button"
                variant="ghost"
                disabled={busyId === item.approvalId}
                onClick={() => void decide(item.approvalId, 'rejected')}
              >
                Deny
              </Button>
            </div>
          </section>
        );
      })}
    </div>
  );
}
