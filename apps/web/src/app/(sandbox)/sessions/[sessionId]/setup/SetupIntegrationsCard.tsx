'use client';

import { useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { usePathname, useSearchParams } from 'next/navigation';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  MCP_INTEGRATIONS,
  SETUP_INTEGRATIONS,
  SETUP_INTEGRATIONS_CONTINUE_OPTION,
  SETUP_INTEGRATIONS_QUESTION_ID,
  isDeploymentScopedMcpIntegration,
  type AcpRequestUserInputPayload,
} from '@roomote/types';

import {
  ArrowRight,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Plug,
  Skeleton,
} from '@/components/system';
import { McpIcon } from '@/components/settings/McpIcon';
import {
  useConnectMcp,
  useEffectiveMcpIntegrations,
} from '@/hooks/mcp-connections';
import { useAuthorizedUser } from '@/hooks/useUser';
import { useTelemetry } from '@/hooks/useTelemetry';
import { useTRPC } from '@/trpc/client';
import { SetupSessionActionCard } from './SetupSessionActionCard';

const Integrations = dynamic(() =>
  import('@/components/settings/Integrations').then(
    (module) => module.Integrations,
  ),
);

export function SetupIntegrationsCard({
  sessionId,
  request,
}: {
  sessionId: string;
  request: Pick<
    AcpRequestUserInputPayload,
    'requestId' | 'questions' | 'preset'
  >;
}) {
  const trpc = useTRPC();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { isAdmin } = useAuthorizedUser();
  const { enabled, capture } = useTelemetry();
  const effectiveIntegrations = useEffectiveMcpIntegrations();
  const connectMcp = useConnectMcp();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [continued, setContinued] = useState(false);
  const shownRequest = useRef<string | null>(null);
  const skippedRequest = useRef<string | null>(null);

  const matchedIds = new Set(
    request.questions
      .find((question) => question.id === SETUP_INTEGRATIONS_QUESTION_ID)
      ?.options?.map((option) => option.id) ?? [],
  );
  const visibleIntegrations = SETUP_INTEGRATIONS.filter((integration) =>
    matchedIds.has(integration.id),
  );
  const matchedCount = visibleIntegrations.length;

  useEffect(() => {
    if (
      !enabled ||
      matchedCount === 0 ||
      shownRequest.current === request.requestId
    )
      return;
    shownRequest.current = request.requestId;
    capture('setup_integrations_shown', { matchedCount });
  }, [capture, enabled, matchedCount, request.requestId]);

  const submit = useMutation(
    trpc.setup.submitSessionUserInput.mutationOptions({
      onSuccess: () => {
        capture('setup_integrations_continued');
        setContinued(true);
      },
      onError: (error) => toast.error(error.message),
    }),
  );
  const { mutate } = submit;
  useEffect(() => {
    if (matchedCount !== 0 || skippedRequest.current === request.requestId)
      return;
    skippedRequest.current = request.requestId;
    mutate({
      sessionId,
      requestId: request.requestId,
      answers: {
        [SETUP_INTEGRATIONS_QUESTION_ID]: {
          answers: [SETUP_INTEGRATIONS_CONTINUE_OPTION.label],
        },
      },
    });
  }, [matchedCount, mutate, request.requestId, sessionId]);
  const refresh = () => {
    void effectiveIntegrations.refetch();
  };
  const statusPending = effectiveIntegrations.isPending;
  const statusError = effectiveIntegrations.isError;
  const active = SETUP_INTEGRATIONS.find(
    (integration) => integration.id === activeId,
  );
  const activeDefinition = MCP_INTEGRATIONS.find(
    (integration) => integration.id === activeId,
  );
  const effectiveById = new Map(
    (effectiveIntegrations.data ?? []).map((integration) => [
      integration.id,
      integration,
    ]),
  );
  const getStatus = (integration: (typeof SETUP_INTEGRATIONS)[number]) => {
    if (statusPending || statusError) return null;
    const status = effectiveById.get(integration.id)?.status;
    if (status === 'connected') return 'Connected';
    if (
      status === 'not_enabled' &&
      effectiveById.get(integration.id)?.authStatus === 'authenticated'
    )
      return 'Not enabled';
    if (status === 'needs_connection') return 'Needs connection';
    return null;
  };
  const authFailed =
    searchParams.get('mcp') === 'error' || searchParams.get('error') !== null;

  if (continued) return null;

  const keepGoing = (
    <Button
      type="button"
      variant="outline"
      disabled={submit.isPending}
      onClick={() =>
        mutate({
          sessionId,
          requestId: request.requestId,
          answers: {
            [SETUP_INTEGRATIONS_QUESTION_ID]: {
              answers: [SETUP_INTEGRATIONS_CONTINUE_OPTION.label],
            },
          },
        })
      }
    >
      Keep going <ArrowRight />
    </Button>
  );
  const continuationError = submit.isError ? (
    <p role="alert" className="text-sm text-destructive">
      Couldn&apos;t continue setup. Please try again.
    </p>
  ) : null;
  if (matchedCount === 0) {
    return submit.isError ? (
      <div className="space-y-2">
        {continuationError}
        {keepGoing}
      </div>
    ) : null;
  }

  return (
    <SetupSessionActionCard
      title="Bring your team's tools along"
      icon={<Plug />}
      intro="Connect the tools you use so I can work with your team's context."
    >
      {authFailed ? (
        <p role="alert" className="text-sm text-destructive">
          Authorization didn&apos;t finish. You can try connecting again or
          continue without it.
        </p>
      ) : null}
      {statusError ? (
        <p role="alert" className="text-sm text-destructive">
          I couldn&apos;t load connection status. You can still connect a tool
          or keep going.
        </p>
      ) : null}
      {effectiveIntegrations.data?.some(
        (integration) => integration.status === 'unavailable',
      ) ? (
        <p className="text-sm text-muted-foreground">
          Tool integrations are disabled by the deployment operator. You can
          still continue setup.
        </p>
      ) : null}
      {!isAdmin ? (
        <p className="text-sm text-muted-foreground">
          An administrator can configure these connections.
        </p>
      ) : null}
      <ul
        className="divide-y divide-border"
        aria-label="Available integrations"
      >
        {visibleIntegrations.map((integration) => {
          const definition = MCP_INTEGRATIONS.find(
            (entry) => entry.id === integration.id,
          );
          const status = getStatus(integration);
          const effective = effectiveById.get(integration.id);
          const unavailable = effective?.status === 'unavailable';
          return (
            <li
              key={integration.id}
              className="flex flex-wrap items-center gap-2 py-3"
            >
              {definition ? (
                <McpIcon icon={definition.icon} name={integration.name} />
              ) : null}
              <div className="min-w-0 flex-1 basis-28">
                <span className="font-medium">{integration.name}</span>
                {statusPending ? (
                  <Skeleton className="mt-1 h-3 w-20" />
                ) : unavailable || status || statusError ? (
                  <p className="text-xs text-muted-foreground">
                    {unavailable
                      ? 'Unavailable on this instance'
                      : (status ?? 'Status unavailable')}
                  </p>
                ) : null}
              </div>
              <Button
                type="button"
                size="sm"
                aria-label={`${status === 'Connected' ? 'Manage' : 'Connect'} ${integration.name}`}
                disabled={!isAdmin || unavailable || submit.isPending}
                onClick={() => {
                  capture('setup_integration_configuration_opened', {
                    integration_id: integration.id,
                  });
                  setActiveId(integration.id);
                }}
              >
                {status === 'Connected' ? 'Manage' : 'Connect'}
              </Button>
            </li>
          );
        })}
      </ul>
      {keepGoing}
      {continuationError}
      <Dialog
        open={active != null}
        onOpenChange={(open) => {
          if (!open) {
            setActiveId(null);
            refresh();
          }
        }}
      >
        <DialogContent size="2xl">
          <DialogHeader>
            <DialogTitle>
              {active ? `Connect ${active.name}` : 'Connect a tool'}
            </DialogTitle>
            <DialogDescription>
              Use the secure configuration below. You can cancel and continue
              setup without connecting.
            </DialogDescription>
          </DialogHeader>
          {active ? <Integrations integrationIds={[active.id]} /> : null}
          {active &&
          activeDefinition &&
          active.id !== 'linear' &&
          !isDeploymentScopedMcpIntegration(activeDefinition) &&
          effectiveById.get(active.id)?.status === 'needs_connection' ? (
            <Button
              disabled={connectMcp.isPending}
              onClick={() =>
                connectMcp.mutate(
                  { mcpId: active.id, redirectTo: pathname },
                  {
                    onSuccess: (url) => {
                      window.location.href = url;
                    },
                    onError: (error) => toast.error(error.message),
                  },
                )
              }
            >
              Connect my {active.name} account
            </Button>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setActiveId(null);
                refresh();
              }}
            >
              Back to setup
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SetupSessionActionCard>
  );
}
