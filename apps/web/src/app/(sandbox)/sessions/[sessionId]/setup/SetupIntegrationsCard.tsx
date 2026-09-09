'use client';

import { useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { usePathname, useSearchParams } from 'next/navigation';
import { useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  MCP_INTEGRATIONS,
  SETUP_INTEGRATIONS,
  SETUP_INTEGRATION_CATEGORIES,
  SETUP_INTEGRATIONS_CONTINUE_OPTION,
  SETUP_INTEGRATIONS_QUESTION_ID,
  isDeploymentScopedMcpIntegration,
  type AcpRequestUserInputPayload,
} from '@roomote/types';

import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Plug,
  RefreshCw,
  Skeleton,
} from '@/components/system';
import { McpIcon } from '@/components/settings/McpIcon';
import {
  useConnectMcp,
  useCuratedIntegrationsAvailability,
  useDeploymentMcpEnablements,
  useUserMcpConnections,
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
  const onboarding = useQuery(trpc.onboarding.status.queryOptions());
  const enablements = useDeploymentMcpEnablements();
  const connections = useUserMcpConnections();
  const availability = useCuratedIntegrationsAvailability();
  const connectMcp = useConnectMcp();
  const [showAll, setShowAll] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [continued, setContinued] = useState(false);
  const shownRequest = useRef<string | null>(null);

  const matchedIds = new Set(
    request.questions
      .find((question) => question.id === SETUP_INTEGRATIONS_QUESTION_ID)
      ?.options?.map((option) => option.id) ?? [],
  );
  const matchedCount = SETUP_INTEGRATIONS.filter((integration) =>
    matchedIds.has(integration.id),
  ).length;

  useEffect(() => {
    if (!enabled || shownRequest.current === request.requestId) return;
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
  const refresh = () => {
    void onboarding.refetch();
    void enablements.refetch();
    void connections.refetch();
    void availability.refetch();
  };
  const statusPending =
    onboarding.isPending || enablements.isPending || connections.isPending;
  const statusError =
    onboarding.isError ||
    enablements.isError ||
    connections.isError ||
    availability.isError;
  const active = SETUP_INTEGRATIONS.find(
    (integration) => integration.id === activeId,
  );
  const activeDefinition = MCP_INTEGRATIONS.find(
    (integration) => integration.id === activeId,
  );
  const authenticatedIds = new Set(
    (connections.data ?? [])
      .filter((connection) => connection.authStatus === 'authenticated')
      .map((connection) => connection.mcpId),
  );
  const enabledIds = new Set(
    (enablements.data ?? [])
      .filter((entry) => entry.enabled)
      .map((entry) => entry.mcpId),
  );
  const getStatus = (integration: (typeof SETUP_INTEGRATIONS)[number]) => {
    if (statusPending || statusError) return null;
    if (integration.id === 'linear')
      return onboarding.data?.orgHasLinear ? 'Connected' : 'Available';
    if (authenticatedIds.has(integration.id))
      return enabledIds.has(integration.id) ? 'Connected' : 'Not enabled';
    return enabledIds.has(integration.id) ? 'Needs connection' : 'Available';
  };
  const hasConnections = SETUP_INTEGRATIONS.some(
    (integration) => getStatus(integration) === 'Connected',
  );
  const previewIds = new Set(
    SETUP_INTEGRATION_CATEGORIES.map((category) => category.integrationIds[0]),
  );
  const visibleIntegrations = SETUP_INTEGRATIONS.filter(
    (integration) =>
      showAll ||
      matchedIds.has(integration.id) ||
      previewIds.has(integration.id),
  );
  const authFailed =
    searchParams.get('mcp') === 'error' || searchParams.get('error') !== null;

  if (continued)
    return (
      <p className="text-sm text-muted-foreground">
        You can connect more tools any time in Settings.
      </p>
    );

  return (
    <SetupSessionActionCard
      title="Bring your team's tools along"
      icon={<Plug />}
      intro="Connect the tools you use so I can work with your team's context, not just your code. This is optional."
    >
      {matchedCount > 0 ? (
        <p className="text-sm text-muted-foreground">
          I&apos;ve highlighted the available connectors that match your
          answers.
        </p>
      ) : null}
      {authFailed ? (
        <p role="alert" className="text-sm text-destructive">
          Authorization didn&apos;t finish. You can try connecting again or
          continue without it.
        </p>
      ) : null}
      {statusError ? (
        <p role="alert" className="text-sm text-destructive">
          I couldn&apos;t refresh connection status. Try Refresh status, or
          continue setup.
        </p>
      ) : null}
      {availability.data?.enabled === false ? (
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
          const unavailable = availability.data?.enabled === false;
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
                ) : (
                  <p className="text-xs text-muted-foreground">
                    {unavailable
                      ? 'Unavailable on this instance'
                      : (status ?? 'Status unavailable')}
                  </p>
                )}
              </div>
              {matchedIds.has(integration.id) ? (
                <Badge variant="secondary">Your tools</Badge>
              ) : null}
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-label={`Configure ${integration.name}`}
                disabled={!isAdmin || unavailable || submit.isPending}
                onClick={() => {
                  capture('setup_integration_configuration_opened', {
                    integration_id: integration.id,
                  });
                  setActiveId(integration.id);
                }}
              >
                {status === 'Connected' ? 'Manage' : 'Set up'}
              </Button>
            </li>
          );
        })}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setShowAll(!showAll)}
        >
          {showAll
            ? 'Show fewer tools'
            : `See all ${SETUP_INTEGRATIONS.length} integrations`}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={refresh}>
          <RefreshCw />
          Refresh status
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Don&apos;t see your tool? There may not be a built-in connector for it
        yet. No credentials belong in this conversation.
      </p>
      <Button
        type="button"
        disabled={submit.isPending}
        onClick={() =>
          submit.mutate({
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
        {submit.isPending
          ? 'Continuing...'
          : hasConnections
            ? 'Continue setup'
            : 'Continue without connections'}
      </Button>
      {submit.isError ? (
        <p role="alert" className="text-sm text-destructive">
          Couldn&apos;t continue setup. Please try again.
        </p>
      ) : null}
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
          enabledIds.has(active.id) &&
          !authenticatedIds.has(active.id) ? (
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
