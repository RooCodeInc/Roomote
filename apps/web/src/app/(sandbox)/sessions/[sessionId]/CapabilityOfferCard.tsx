'use client';

import { useCallback, useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  MCP_INTEGRATIONS,
  SETUP_INTEGRATIONS,
  SETUP_INTEGRATION_RECOMMENDATIONS,
  type FastAgentCapabilityOfferPayload,
} from '@roomote/types';

import { SETTINGS_PATHS } from '@/lib/settings';
import { SETUP_STARTER_TASKS } from '@/lib/setup-starter-tasks';
import { useTRPC } from '@/trpc/client';
import { Button, Checkbox, ListChecks, Plug } from '@/components/system';
import { McpIcon } from '@/components/settings/McpIcon';

import { SetupSessionActionCard } from './setup/SetupSessionActionCard';
import { SetupSessionSourceControlCardBody } from './setup/SetupSourceControlCard';
import { SetupSandboxCard } from './setup/SetupSandboxCard';
import { SetupAutomationRecommendationsCard } from './setup/SetupAutomationRecommendationsCard';

export function CapabilityOfferCard({
  sessionId,
  offer,
}: {
  sessionId: string;
  offer: FastAgentCapabilityOfferPayload;
}) {
  const trpc = useTRPC();
  const router = useRouter();
  const [selectedTaskIds, setSelectedTaskIds] = useState<string[]>(
    SETUP_STARTER_TASKS.map((task) => task.id),
  );
  const status = useQuery(trpc.setupNew.status.queryOptions());
  const deploymentEnablements = useQuery(
    trpc.mcpConnections.deploymentEnablements.queryOptions(),
  );
  const connectedIntegrationIds = new Set(
    deploymentEnablements.data
      ?.filter((enablement) => enablement.enabled)
      .map((enablement) => enablement.mcpId) ?? [],
  );
  const requestedIntegrationIds = offer.integrationIds?.length
    ? offer.integrationIds
    : [...SETUP_INTEGRATION_RECOMMENDATIONS];
  const resolve = useMutation(
    trpc.fastSessions.resolveCapabilityOffer.mutationOptions({
      onError: (error) => toast.error(error.message),
    }),
  );
  const finish = useCallback(
    (resolution: 'completed' | 'dismissed', selectedIds?: string[]) =>
      resolve.mutate({
        sessionId,
        offerId: offer.offerId,
        capability: offer.capability,
        resolution,
        selectedIds,
      }),
    [offer.capability, offer.offerId, resolve, sessionId],
  );

  const capabilityReady =
    (offer.capability === 'source_control' &&
      status.data?.sourceControlSetup.providers.some(
        (provider) =>
          provider.connected &&
          (provider.repositoryCount ?? 0) > 0 &&
          (!offer.provider || provider.provider === offer.provider),
      )) ||
    (offer.capability === 'sandbox' &&
      status.data?.computeSetup.setupSatisfied === true) ||
    (offer.capability === 'integrations' &&
      requestedIntegrationIds.length > 0 &&
      requestedIntegrationIds.every((id) => connectedIntegrationIds.has(id))) ||
    (offer.capability === 'automation_recommendations' &&
      status.data?.setupNewState.automationRecommendations &&
      (status.data.setupNewState.automationRecommendations.applicationState ??
        'pending') !== 'pending');

  useEffect(() => {
    if (capabilityReady && !resolve.isPending && !resolve.isSuccess) {
      finish('completed');
    }
  }, [capabilityReady, finish, resolve.isPending, resolve.isSuccess]);

  if (resolve.isSuccess || capabilityReady) return null;

  if (offer.capability === 'source_control') {
    const sourceControlSetup = status.data?.sourceControlSetup;
    if (!sourceControlSetup) return null;
    return (
      <SetupSessionSourceControlCardBody
        sourceControlSetup={sourceControlSetup}
        explicitlySelectedProvider={null}
        preferredProvider={offer.provider}
        sessionId={sessionId}
        onDismiss={() => finish('dismissed')}
      />
    );
  }

  if (offer.capability === 'sandbox') {
    return (
      <SetupSandboxCard forceVisible onDismiss={() => finish('dismissed')} />
    );
  }

  if (offer.capability === 'automation_recommendations') {
    return (
      <SetupAutomationRecommendationsCard
        forceVisible
        onResolved={() => finish('completed')}
      />
    );
  }

  if (offer.capability === 'starter_work') {
    return (
      <SetupSessionActionCard
        title="I found stuff I can work on"
        icon={<ListChecks />}
        intro={offer.message}
      >
        <div className="space-y-2">
          {SETUP_STARTER_TASKS.map((task) => (
            <label key={task.id} className="flex items-start gap-2">
              <Checkbox
                checked={selectedTaskIds.includes(task.id)}
                onCheckedChange={(checked) =>
                  setSelectedTaskIds((current) =>
                    checked
                      ? [...new Set([...current, task.id])]
                      : current.filter((id) => id !== task.id),
                  )
                }
              />
              <span>
                <span className="block font-medium">{task.title}</span>
                <span className="block text-muted-foreground">
                  {task.description}
                </span>
              </span>
            </label>
          ))}
        </div>
        <div className="flex gap-2">
          <Button
            type="button"
            size="sm"
            disabled={resolve.isPending || selectedTaskIds.length === 0}
            onClick={() => finish('completed', selectedTaskIds)}
          >
            Start selected work
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={resolve.isPending}
            onClick={() => finish('dismissed')}
          >
            Not now
          </Button>
        </div>
      </SetupSessionActionCard>
    );
  }

  const integrations = SETUP_INTEGRATIONS.filter(
    (integration) =>
      requestedIntegrationIds.includes(integration.id) &&
      !connectedIntegrationIds.has(integration.id),
  );
  return (
    <SetupSessionActionCard
      title="Bring your team's tools along"
      icon={<Plug />}
      intro={offer.message}
    >
      <ul className="divide-y divide-border">
        {integrations.map((integration) => {
          const definition = MCP_INTEGRATIONS.find(
            (candidate) => candidate.id === integration.id,
          );
          return (
            <li key={integration.id} className="flex items-center gap-3 py-3">
              {definition ? (
                <McpIcon icon={definition.icon} name={integration.name} />
              ) : null}
              <span className="min-w-0 flex-1 font-medium">
                {integration.name}
              </span>
              <Button
                type="button"
                size="sm"
                onClick={() =>
                  router.push(
                    `${SETTINGS_PATHS.integrations}?highlight=${integration.id}`,
                  )
                }
              >
                Connect
              </Button>
            </li>
          );
        })}
      </ul>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={resolve.isPending}
        onClick={() => finish('dismissed')}
      >
        Keep going
      </Button>
    </SetupSessionActionCard>
  );
}
